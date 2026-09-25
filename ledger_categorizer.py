"""
ledger_categorizer.py
=====================
A standalone, zero-side-effect ledger-classification module for bank statement
transactions. Adds a `Suggested_Ledger` column to an already-cleaned pandas
DataFrame by running each transaction narration through a 4-layer cascade:

  Layer 1 - Sanitize the raw narration (strip noise)
  Layer 2 - Rule-based keyword dictionary lookup
  Layer 3 - Fuzzy match against a historical mapping DataFrame (>=85% score)
  Layer 4 - LLM API stub (call-through for unclassified transactions)

Design constraints
------------------
* Pure Python / stdlib + pandas + rapidfuzz. No other hard dependencies.
* NEVER mutates the caller's DataFrame.  apply() returns a *new* DataFrame
  with one extra column appended at the right-most position.
* All layers degrade gracefully: a missing rapidfuzz install, an empty
  history DF, or a non-responsive LLM stub all fall through to the next layer
  without raising an exception.
* The public API (apply, classify_one) is stable; internals may evolve.

Usage
-----
    from ledger_categorizer import LedgerCategorizer

    categorizer = LedgerCategorizer()
    df_out = categorizer.apply(df, narration_col="Narration")

    # Or classify a single narration string:
    ledger = categorizer.classify_one("UPI/SWIGGY INFOTECH/FOOD")
"""

from __future__ import annotations

import re
import logging
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependency: rapidfuzz
# ---------------------------------------------------------------------------
try:
    from rapidfuzz import process as _rf_process  # type: ignore
    _RAPIDFUZZ_AVAILABLE = True
except ImportError:
    _rf_process = None  # type: ignore
    _RAPIDFUZZ_AVAILABLE = False
    logger.warning(
        "rapidfuzz is not installed. Layer 3 (fuzzy matching) will be skipped. "
        "Install it with:  pip install rapidfuzz"
    )


# ---------------------------------------------------------------------------
# Layer 1 - Sanitization helpers
# ---------------------------------------------------------------------------

# These patterns represent noise that appears in bank narrations but carries
# no ledger-classification signal.
_DATE_PATTERN = re.compile(
    r'\b\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}\b'
    r'|\b\d{4}[/\-\.]\d{2}[/\-\.]\d{2}\b'
    r'|\b\d{1,2}[/\-\.]\w{3}[/\-\.]\d{2,4}\b',
    re.IGNORECASE,
)
_REFERENCE_NUMBERS = re.compile(r'\b[A-Z0-9]{10,}\b')
_SPECIAL_CHARS = re.compile(r'[^a-z0-9\s]')
_MULTI_SPACE = re.compile(r'\s{2,}')


def sanitize(narration: str) -> str:
    """
    Layer 1: Produce a clean, lowercase, noise-free version of the narration
    suitable for keyword or fuzzy matching.

    Steps:
        1. Lowercase
        2. Remove embedded dates
        3. Remove long alphanumeric reference codes (UTR/UPI IDs)
        4. Strip all remaining special characters
        5. Collapse multiple spaces
        6. Strip leading/trailing whitespace
    """
    text = str(narration).lower()
    text = _DATE_PATTERN.sub(" ", text)
    text = _REFERENCE_NUMBERS.sub(" ", text)
    text = _SPECIAL_CHARS.sub(" ", text)
    text = _MULTI_SPACE.sub(" ", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Layer 2 - Rule-Based Keyword Dictionary
# ---------------------------------------------------------------------------

KEYWORD_RULES: dict = {
    # Purchases / COGS
    "Purchase Account":         ["purchase", "vendor payment", "supplier"],
    "Raw Material Purchase":    ["raw material", "rm purchase", "bom"],

    # Sales
    "Sales Account":            ["sales", "sale proceed", "invoice payment"],

    # Bank Charges and Fees
    "Bank Charges":             ["bank charge", "service charge", "maintenance fee",
                                 "annual fee", "demat", "locker charge", "sms charge",
                                 "gst on bank", "interest on od", "processing fee"],
    "Loan Repayment":           ["emi", "loan repay", "home loan", "car loan",
                                 "lic premium", "insurance premium"],

    # Utilities
    "Electricity Charges":      ["electricity", "bescom", "msedcl", "tpddl",
                                 "power supply", "bses", "tneb"],
    "Telephone Expenses":       ["airtel", "jio", "vodafone", "bsnl", "vi ",
                                 "broadband", "internet bill", "mobile recharge",
                                 "telecom"],
    "Water Charges":            ["water bill", "bwssb", "municipal water"],
    "Gas Expenses":             ["gas bill", "igl ", "mgl ", "adani gas",
                                 "piped gas", "lpg"],

    # Office and Admin
    "Rent":                     ["rent", "lease", "tenancy"],
    "Office Expenses":          ["stationery", "office supply", "printing",
                                 "courier", "postage", "stamp"],
    "Repairs and Maintenance":  ["repair", "maintenance", "servicing", "amc "],
    "Professional Charges":     ["ca fee", "audit fee", "legal fee", "consultant",
                                 "professional fee", "advocate"],
    "Advertisement Expenses":   ["advertisement", "ads", "google ads", "facebook ads",
                                 "marketing", "promotion"],

    # Travel and Conveyance
    "Travel Expenses":          ["irctc", "railway", "flight", "airline", "indigo",
                                 "spicejet", "air india", "makemytrip",
                                 "cleartrip", "yatra", "ola ", "uber ", "rapido"],
    "Conveyance Expenses":      ["petrol", "diesel", "fuel", "cng ", "fastag",
                                 "toll ", "parking"],

    # Food and Entertainment
    "Staff Welfare":            ["swiggy", "zomato", "food", "canteen", "tea",
                                 "lunch", "dinner", "breakfast"],
    "Entertainment Expenses":   ["netflix", "hotstar", "prime video", "spotify",
                                 "amazon prime", "cinema", "movie"],

    # Taxes
    "GST Payable":              ["gst payment", "gst challan", "gstn"],
    "TDS Payable":              ["tds deposit", "tax deducted", "tds challan"],
    "Income Tax":               ["income tax", "advance tax", "self assessment tax",
                                 "itr refund"],
    "Professional Tax":         ["professional tax", "pt payment"],

    # Payroll
    "Salary":                   ["salary", "payroll", "wages", "staff payment"],
    "EPF PF":                   ["epf", "pf contribution", "provident fund", "pfms"],

    # Investments and Transfers
    "Investments":              ["mutual fund", "sip ", "nps ", "equity",
                                 "stocks", "zerodha", "groww", "kuvera",
                                 "investment"],

    # Cash and ATM
    "Cash Withdrawal":          ["atm withdrawal", "cash withdrawal", "cash w/d",
                                 "atm wd", "cash w/d"],
    "Cash Deposit":             ["cash deposit", "cash dep", "atm deposit"],

    # Cheque / clearing transactions — must come BEFORE the generic Bank Transfer
    # entry so that "clg"/"clearing" is captured here, not in Suspense.
    "Cheque Clearing":          ["clg/", "/clg", "chq clg", "cheque clearing",
                                 "by clg", "by clearing", "clearing chq",
                                 "clearing cheque", "nach debit", "nach credit",
                                 "ecs debit", "ecs credit", "ach debit", "ach credit"],

    # Inter-Bank Transfers (last - least specific)
    # "upi" matched with and without trailing space/slash after sanitization
    "Bank Transfer":            ["neft", "rtgs", "imps", "upi/", "upi ",
                                 "fund transfer", "by transfer", "to transfer",
                                 "internet banking", "ibank", "netbanking"],

    # Suspense — ONLY the literal word, never 'clearing' or 'transit'
    # (those are normal bank operations, not suspense entries).
    # Kept last so specific rules above always win first.
    "Suspense Account":         ["suspense"],
}


def _keyword_rule_lookup(sanitized: str) -> Optional[str]:
    """
    Layer 2: Scan KEYWORD_RULES and return the first ledger whose keyword list
    has at least one match in sanitized.  Returns None if no rule fires.
    """
    for ledger, keywords in KEYWORD_RULES.items():
        for kw in keywords:
            if kw in sanitized:
                return ledger
    return None


# ---------------------------------------------------------------------------
# Layer 3 - Fuzzy Matching against historical mappings
# ---------------------------------------------------------------------------

def _fuzzy_lookup(
    sanitized: str,
    history_df: pd.DataFrame,
    narration_col: str,
    ledger_col: str,
    threshold: int = 85,
) -> Optional[str]:
    """
    Layer 3: Use rapidfuzz to find the closest match in history_df.
    Returns the mapped ledger if the best match score is >= threshold, else None.
    """
    if not _RAPIDFUZZ_AVAILABLE or history_df is None or history_df.empty:
        return None

    choices = history_df[narration_col].astype(str).tolist()
    if not choices:
        return None

    result = _rf_process.extractOne(sanitized, choices, score_cutoff=threshold)
    if result is None:
        return None

    match_str, score, match_idx = result
    matched_ledger = history_df.iloc[match_idx][ledger_col]
    logger.debug(
        "Fuzzy match: %r -> %r (score=%s, ledger=%r)",
        sanitized, match_str, score, matched_ledger,
    )
    return str(matched_ledger)


# ---------------------------------------------------------------------------
# Layer 4 - LLM API Fallback (stub)
# ---------------------------------------------------------------------------

def call_llm_classification(
    narration: str,
    available_ledgers: list,
) -> Optional[str]:
    """
    Layer 4 stub: call an LLM to classify a transaction narration.

    Replace the body of this function with a real API call (e.g. Mistral,
    OpenAI, or a local LLM endpoint) when ready.  The stub always returns
    None, which causes the categorizer to record "Unclassified" for the
    transaction -- a safe, visible sentinel that makes it easy to audit which
    rows need manual review.

    Parameters
    ----------
    narration         : the *original* (un-sanitized) transaction narration.
    available_ledgers : the full list of Tally ledger names to choose from.

    Returns
    -------
    str | None
        A ledger name from available_ledgers, or None if classification failed.

    Example implementation skeleton (Mistral)::

        import os, json
        from mistralai.client import MistralClient

        client = MistralClient(api_key=os.environ["MISTRAL_API_KEY"])
        prompt = (
            f"You are a Tally ERP accountant.\\n"
            f"Transaction: {narration}\\n"
            f"Choose the single best ledger from: {available_ledgers}\\n"
            f"Reply with ONLY the ledger name, nothing else."
        )
        response = client.chat(
            model="mistral-small-latest",
            messages=[{"role": "user", "content": prompt}],
        )
        answer = response.choices[0].message.content.strip()
        if answer in available_ledgers:
            return answer
        return None
    """
    logger.debug(
        "LLM stub called for narration %r -- returning None (not yet wired).",
        narration,
    )
    return None


# ---------------------------------------------------------------------------
# Public API: LedgerCategorizer
# ---------------------------------------------------------------------------

class LedgerCategorizer:
    """
    Classify bank transaction narrations into Tally ledger categories using
    a 4-layer cascade.

    Parameters
    ----------
    history_df         : Optional pandas DataFrame of confirmed past mappings.
    history_narr_col   : Column name in history_df holding narration text.
    history_ledger_col : Column name in history_df holding the ledger name.
    fuzzy_threshold    : Minimum rapidfuzz match score (0-100). Defaults to 85.
    use_llm            : Whether to attempt Layer 4. Defaults to True.
    available_ledgers  : List of valid Tally ledger names for LLM stub.
    unclassified_label : Label when all four layers fail. Defaults to "Unclassified".
    """

    def __init__(
        self,
        history_df=None,
        history_narr_col: str = "Narration",
        history_ledger_col: str = "Ledger",
        fuzzy_threshold: int = 85,
        use_llm: bool = True,
        available_ledgers=None,
        unclassified_label: str = "Unclassified",
    ) -> None:
        self.history_df = history_df
        self.history_narr_col = history_narr_col
        self.history_ledger_col = history_ledger_col
        self.fuzzy_threshold = fuzzy_threshold
        self.use_llm = use_llm
        self.available_ledgers = available_ledgers or list(KEYWORD_RULES.keys())
        self.unclassified_label = unclassified_label

        # Pre-sanitize history narrations once so each classify_one() call
        # does not redo it per-row.
        self._sanitized_history = None
        if history_df is not None and not history_df.empty:
            try:
                h = history_df.copy()
                h["_sanitized"] = h[history_narr_col].apply(sanitize)
                self._sanitized_history = h
            except KeyError as exc:
                logger.warning(
                    "history_df is missing column %r -- Layer 3 disabled. Error: %s",
                    exc, exc,
                )

    def classify_one(self, narration: str) -> str:
        """
        Run the 4-layer cascade for a single narration string.

        Returns
        -------
        str
            A Tally ledger name, or self.unclassified_label if all layers fail.
        """
        # Layer 1: Sanitize
        clean = sanitize(narration)

        # Layer 2: Rule-based keyword lookup
        result = _keyword_rule_lookup(clean)
        if result is not None:
            return result

        # Layer 3: Fuzzy match
        if self._sanitized_history is not None:
            result = _fuzzy_lookup(
                clean,
                self._sanitized_history,
                "_sanitized",
                self.history_ledger_col,
                self.fuzzy_threshold,
            )
            if result is not None:
                return result

        # Layer 4: LLM API stub
        if self.use_llm:
            result = call_llm_classification(narration, self.available_ledgers)
            if result is not None:
                return result

        return self.unclassified_label

    def apply(
        self,
        df: pd.DataFrame,
        narration_col=None,
        output_col: str = "Suggested_Ledger",
    ) -> pd.DataFrame:
        """
        Add a Suggested_Ledger column to df without mutating the original.

        Uses df.assign() so the caller's DataFrame is never modified.
        Auto-detects the narration column if narration_col is None.

        Parameters
        ----------
        df            : The cleaned bank statement DataFrame.
        narration_col : Column to read narrations from (auto-detected if None).
        output_col    : Column to write suggested ledgers into.

        Returns
        -------
        pd.DataFrame
            A *new* DataFrame with all original columns plus output_col as the
            rightmost column. Existing column order and dtypes are unchanged.
        """
        _NARR_CANDIDATES = [
            "Narration", "Particulars", "Description", "Details",
            "Transaction Details", "Transaction Narration",
            "Remarks", "NARRATION", "DESCRIPTION",
        ]
        if narration_col is None:
            for candidate in _NARR_CANDIDATES:
                if candidate in df.columns:
                    narration_col = candidate
                    break
        if narration_col is None:
            for col in df.columns:
                cl = col.lower()
                if any(kw in cl for kw in ("narr", "particular", "descri", "remark", "detail")):
                    narration_col = col
                    break

        if narration_col is None or narration_col not in df.columns:
            logger.warning(
                "LedgerCategorizer: could not find a narration column in %s. "
                "Setting '%s' to %r for all rows.",
                list(df.columns), output_col, self.unclassified_label,
            )
            return df.assign(**{output_col: self.unclassified_label})

        suggested = df[narration_col].fillna("").astype(str).map(self.classify_one)
        return df.assign(**{output_col: suggested})
