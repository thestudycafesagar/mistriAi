import time
import re
import os
import cv2
import numpy as np
import pdfplumber
import pandas as pd
import pytesseract
from pdf2image import convert_from_path
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

# =================================================================
# NEW: Universal OCR Engine
# =================================================================

def extract_tables_with_ocr(img):
    """
    Uses Tesseract OCR to scan images/scanned PDFs.
    It groups text bounding boxes into rows (by Y-coordinate) 
    and columns (by X-coordinate), outputting a strict 2D table grid
    that perfectly mimics pdfplumber's output.
    """
    # Convert PIL Image to OpenCV format if needed
    if not isinstance(img, np.ndarray):
        img = np.array(img)
        
    if len(img.shape) == 3 and img.shape[2] == 3:
        img_gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        img_gray = img
        
    # Binarize image for better OCR readability
    _, thresh = cv2.threshold(img_gray, 150, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    
    # Run Tesseract
    data = pytesseract.image_to_data(thresh, output_type=pytesseract.Output.DICT)
    
    boxes = []
    for i in range(len(data['text'])):
        text = data['text'][i].strip()
        if text: # Ignore empty/noise detections
            boxes.append({
                'x': data['left'][i],
                'y': data['top'][i],
                'text': text
            })
            
    if not boxes:
        return []
        
    # 1. Group into ROWS by Y-coordinate
    boxes.sort(key=lambda b: b['y'])
    rows = []
    current_row = [boxes[0]]
    y_tolerance = 12  # Pixels tolerance for items on the same horizontal line
    
    for box in boxes[1:]:
        if abs(box['y'] - current_row[0]['y']) <= y_tolerance:
            current_row.append(box)
        else:
            rows.append(current_row)
            current_row = [box]
    rows.append(current_row)
    
    # 2. Cluster into COLUMNS by X-coordinate
    all_x = [b['x'] for r in rows for b in r]
    all_x.sort()
    
    columns = []
    x_tolerance = 40  # Pixels tolerance for items in the same vertical column
    curr_col = [all_x[0]]
    for x in all_x[1:]:
        if x - curr_col[-1] <= x_tolerance:
            curr_col.append(x)
        else:
            columns.append(sum(curr_col) / len(curr_col))
            curr_col = [x]
    columns.append(sum(curr_col) / len(curr_col))
    
    # 3. Map bounding boxes to the structured grid
    table = []
    for r in rows:
        row_data = [''] * len(columns)
        r.sort(key=lambda b: b['x']) # Sort horizontally
        
        for b in r:
            # Snap to the closest column
            col_idx = min(range(len(columns)), key=lambda i: abs(columns[i] - b['x']))
            if row_data[col_idx]:
                row_data[col_idx] += ' ' + b['text']
            else:
                row_data[col_idx] = b['text']
        table.append(row_data)
        
    # Return as a list containing one large table, mirroring pdfplumber output
    return [table]

# =================================================================
# EXISTING: Robust Helper functions (Untouched)
# =================================================================

def merge_multirow_header(rows):
    num_cols = max(len(r) for r in rows) if rows else 0
    merged = []
    for col_idx in range(num_cols):
        parts = []
        for row in rows:
            if col_idx < len(row):
                val = str(row[col_idx]).strip() if row[col_idx] else ''
                if val:
                    parts.append(val)
        merged.append(' '.join(parts) if parts else f'Column_{col_idx + 1}')
    return merged

def collapse_table_to_row(table):
    if not table:
        return []
    num_cols = max(len(r) for r in table)
    result = [''] * num_cols
    for row in table:
        for col_idx, cell in enumerate(row):
            if col_idx < num_cols:
                val = str(cell).strip() if cell else ''
                if val:
                    result[col_idx] = (result[col_idx] + ' ' + val).strip() if result[col_idx] else val
    return result

def get_explicit_columns(page, target_headers):
    words = page.extract_words()
    rows = {}
    for w in words:
        y = round(w['top'], 1)
        matched_y = None
        for key_y in rows:
            if abs(key_y - y) < 4:
                matched_y = key_y
                break
        if matched_y is None:
            matched_y = y
            rows[matched_y] = []
        rows[matched_y].append(w)
        
    best_match_count = 0
    best_v_lines = None
    
    for y, rwords in rows.items():
        text = ' '.join(w['text'].lower() for w in rwords)
        matches = sum(1 for t in target_headers if t in text)
        has_date = 'date' in text or 'txn' in text or 'transaction' in text
        
        if has_date and matches >= 2 and matches > best_match_count:
            best_match_count = matches
            v_lines = [page.bbox[0]]
            for w in rwords:
                w_text = w['text'].lower()
                if any(t in w_text or w_text in t for t in target_headers):
                    v_lines.append(w['x0'] - 2)
            v_lines.append(page.bbox[2])
            best_v_lines = sorted(list(set(v_lines)))

    return best_v_lines


def extract_transactions_by_word_coords(pdf_path, target_headers):
    """
    Word-coordinate-based extractor for PDFs where:
    - The header spans multiple visual y-lines (e.g. 'Transaction\\nDate' split across rows)
    - Narration text wraps to adjacent lines above or below the date row

    Algorithm:
      1. Detect all header y-rows (within 20px of first matching row) → derive col x-starts
      2. Pass 1: collect anchor rows = rows with a date at the leftmost column x-zone
      3. Pass 2: assign continuation rows to nearest anchor by y-distance
    """
    DATE_PAT = re.compile(r'^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s|$)')

    with pdfplumber.open(pdf_path) as pdf:
        all_page_words = []
        page_heights = []
        for page in pdf.pages:
            all_page_words.append(page.extract_words())
            page_heights.append(page.bbox[3])

    if not all_page_words:
        return None, None

    # ── Step 1: Detect header rows ────────────────────────────────────────
    # Find the first y-row with 'date'/'txn' + ≥2 target-header keyword matches.
    # Then collect all rows within 25px below it (multi-line header support).
    header_y_range = None  # (y_start, y_end)
    data_start_page = 0
    first_header_y = None

    for pg_idx, words in enumerate(all_page_words):
        y_rows = {}
        for w in words:
            y = round(w['top'])
            matched = next((ky for ky in y_rows if abs(ky - y) <= 5), None)
            if matched is None:
                matched = y
                y_rows[matched] = []
            y_rows[matched].append(w)

        all_words_text = ' '.join(w['text'].lower() for w in words)
        for y in sorted(y_rows):
            rw = sorted(y_rows[y], key=lambda w: w['x0'])
            rt = ' '.join(w['text'].lower() for w in rw)
            matches = sum(1 for t in target_headers if t in rt)
            if ('date' in rt or 'txn' in rt) and matches >= 2:
                first_header_y = y
                data_start_page = pg_idx
                break
        if first_header_y is not None:
            break

    if first_header_y is None:
        return None, None

    # Collect all words in the header y-band (first_header_y ± 25px)
    header_band_words = []
    words_pg0 = all_page_words[data_start_page]
    for w in words_pg0:
        if first_header_y - 5 <= w['top'] <= first_header_y + 25:
            header_band_words.append(w)

    # Derive column x-starts from header band words that match target keywords
    col_entries = []   # list of (x0, name, x1)
    actual_header_ys = []
    for w in sorted(header_band_words, key=lambda w: w['x0']):
        wt = w['text'].lower().strip('():')
        if any(t in wt or wt in t for t in target_headers):
            actual_header_ys.append(w['top'])
            # Merge with previous col if gap between words is small
            if col_entries and (w['x0'] - col_entries[-1][2]) < 10:
                col_entries[-1] = (col_entries[-1][0], col_entries[-1][1] + ' ' + w['text'], w['x1'])
            else:
                col_entries.append((w['x0'], w['text'], w['x1']))

    if len(col_entries) < 3:
        return None, None

    col_names = [c[1] for c in col_entries]
    col_starts = sorted([c[0] for c in col_entries])

    # The end of the header band is the last matched header word's y
    if actual_header_ys:
        header_end_y = max(actual_header_ys) + 5
    else:
        header_end_y = first_header_y + 10

    def get_col_idx(x):
        """Assign x to nearest column by x0 boundaries."""
        idx = 0
        for i, cs in enumerate(col_starts):
            if x >= cs - 8:
                idx = i
        return idx

    # Date column x-zone = everything to the left of the second column start
    date_col_x_max = col_starts[1] - 5 if len(col_starts) > 1 else 120

    # ── Amount-column clustering (fixes right-aligned numeric columns) ────
    # Header labels are left-anchored, but amounts (WITHDRAWALS/DEPOSITS/BALANCE
    # etc.) are right-aligned. A wide value (e.g. "7,07,196.00Dr") can start well
    # to the LEFT of its own header's x0, causing plain x0-vs-header-start
    # matching to snap it into the PREVIOUS column instead. Since right-aligned
    # values in the same column always end (x1) at nearly the same x, cluster the
    # x1 of every amount-looking token across the whole document and match
    # clusters (left→right) to the amount-keyword headers (left→right).
    AMOUNT_KEYWORDS = ('balance', 'amount', 'withdraw', 'deposit', 'credit', 'debit')
    AMOUNT_VALUE_RE = re.compile(r'^[₹$€£]?\s*-?\(?[\d,]+\.\d{1,2}\)?\s*(dr|cr)?$', re.IGNORECASE)

    numeric_cols_sorted = sorted(
        (col_starts[i], i) for i, name in enumerate(col_names)
        if any(k in name.lower() for k in AMOUNT_KEYWORDS)
    )

    cluster_to_col = {}
    amount_clusters = []
    if len(numeric_cols_sorted) >= 2:
        amount_x1s = sorted(
            w['x1'] for words in all_page_words for w in words
            if AMOUNT_VALUE_RE.match(w['text'].strip())
        )
        if amount_x1s:
            clusters = []
            cur = [amount_x1s[0]]
            for x in amount_x1s[1:]:
                if x - cur[-1] <= 40:
                    cur.append(x)
                else:
                    clusters.append(sum(cur) / len(cur))
                    cur = [x]
            clusters.append(sum(cur) / len(cur))
            # Only trust the clustering when it cleanly matches the number of
            # amount columns found in the header — otherwise fall back to the
            # original x0-based logic rather than guess.
            if len(clusters) == len(numeric_cols_sorted):
                for cx, (_, ci) in zip(clusters, numeric_cols_sorted):
                    cluster_to_col[cx] = ci
                amount_clusters = clusters

    def get_amount_col_idx(x1):
        nearest = min(amount_clusters, key=lambda c: abs(c - x1))
        return cluster_to_col[nearest]

    SKIP_PHRASES = [
        'page ', 'generated', 'authorised', 'statement summary',
        'opening balance', 'closing balance', 'total debit', 'total credit',
        'eff avail', 'count of lien', ':12 pm', ':12 am', ' pm )', ' am )',
        'transaction list', 'cumulative total', 'grand total', 'brought forward'
    ]
    BF_PAT = re.compile(r'\bb\s*/\s*f\b', re.IGNORECASE)  # "B/F" brought-forward marker
    DIVIDER_RE = re.compile(r'^[-=_*.\s]+$')

    def is_divider_or_amount_only_row(row_words):
        """
        True for rows with no identifying date/narration text at all — e.g. a bare
        "B/F"-style opening-balance line (just two amounts, no label) or a plain
        "----" divider between the transaction table and a totals footer. These
        aren't real transactions, so they must NOT be merged as a "continuation"
        into a neighboring anchor row (that would silently splice their amounts
        into an unrelated transaction's WITHDRAWALS/DEPOSITS/BALANCE/PARTICULARS).
        """
        texts = [w['text'].strip() for w in row_words if w['text'].strip()]
        if not texts:
            return False
        if all(DIVIDER_RE.match(t) for t in texts):
            return True
        if all(AMOUNT_VALUE_RE.match(t) for t in texts):
            return True
        return False

    # ── Step 2: Collect all rows with global y ────────────────────────────
    all_categorized = []
    cumulative_y = 0

    for pg_idx, words in enumerate(all_page_words):
        y_rows = {}
        for w in words:
            y = round(w['top'])
            matched = next((ky for ky in y_rows if abs(ky - y) <= 5), None)
            if matched is None:
                matched = y
                y_rows[matched] = []
            y_rows[matched].append(w)

        sorted_ys = sorted(y_rows.keys())
        # On the data start page, skip everything up to and including the header band
        if pg_idx == data_start_page:
            sorted_ys = [y for y in sorted_ys if y > header_end_y]

        for y in sorted_ys:
            row_words = sorted(y_rows[y], key=lambda w: w['x0'])
            row_text = ' '.join(w['text'] for w in row_words).lower()

            if any(skip in row_text for skip in SKIP_PHRASES) or BF_PAT.search(row_text):
                continue

            # An anchor row has a date-pattern word within the date-column x-zone
            date_zone_words = [w for w in row_words if w['x0'] < date_col_x_max]
            date_zone_text = ' '.join(w['text'] for w in date_zone_words).strip()
            is_anchor = bool(DATE_PAT.match(date_zone_text))

            # Rows with no date AND no identifying text (bare "B/F"-style opening
            # balance amounts, or a plain "----" divider) aren't real transactions.
            # Drop them outright instead of letting them merge into a neighbor —
            # otherwise their amounts get spliced into an unrelated transaction.
            if not is_anchor and is_divider_or_amount_only_row(row_words):
                continue

            # Assign words to columns.
            # Special rule: the Date column (col 0) should ONLY contain the date value.
            # Any word starting beyond the date column x-zone belongs to narration (col 1+).
            row_by_col = {}
            for w in row_words:
                x = w['x0']
                if x < date_col_x_max:
                    ci = 0  # date zone
                elif cluster_to_col and AMOUNT_VALUE_RE.match(w['text'].strip()):
                    ci = get_amount_col_idx(w['x1'])  # right-aligned amount: match by x1 cluster
                else:
                    ci = get_col_idx(x)
                    if ci == 0:
                        ci = 1  # force into narration if get_col_idx returned 0 for non-date x
                row_by_col[ci] = (row_by_col.get(ci, '') + ' ' + w['text']).strip()

            all_categorized.append({
                'global_y': cumulative_y + y,
                'is_anchor': is_anchor,
                'by_col': row_by_col,
            })

        cumulative_y += page_heights[pg_idx]

    if not all_categorized:
        return None, None

    # ── Step 3: Two-pass merge ────────────────────────────────────────────
    anchor_indices = [i for i, r in enumerate(all_categorized) if r['is_anchor']]

    if not anchor_indices:
        return None, None

    transactions = [dict(all_categorized[i]['by_col']) for i in anchor_indices]
    anchor_global_ys = [all_categorized[i]['global_y'] for i in anchor_indices]
    anchor_set = set(anchor_indices)

    # Maximum y-distance (pts) to consider a row as part of an anchor transaction.
    # RBL narration wraps are ~7px away from the date row.
    # Canara bank statements can have narration lines up to ~36px away.
    # 45px safely catches all continuation lines without merging unrelated transactions.
    MAX_Y_GAP = 45

    for i, row in enumerate(all_categorized):
        if i in anchor_set:
            continue
        gy = row['global_y']
        # Find nearest anchor
        nearest_idx = min(range(len(anchor_global_ys)),
                          key=lambda k: abs(anchor_global_ys[k] - gy))
        distance = abs(anchor_global_ys[nearest_idx] - gy)
        if distance > MAX_Y_GAP:
            continue  # Too far away — skip, don't merge
        target = transactions[nearest_idx]
        for ci, val in row['by_col'].items():
            if ci in target:
                target[ci] = (target[ci] + ' ' + val).strip()
            else:
                target[ci] = val


    # ── Step 4: Convert to list-of-lists ─────────────────────────────────
    num_cols = len(col_names)
    data_rows = []
    for txn in transactions:
        out = [txn.get(i, '') for i in range(num_cols)]
        data_rows.append(out)

    return col_names, data_rows


def clean_numeric(value):
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    s = re.sub(r'^[₹$€£]|^Rs\.?\s*', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*\(?\s*(dr|cr)\s*\)?\.?$', '', s, flags=re.IGNORECASE)  # trailing Dr/Cr suffix, e.g. "645.00Dr" or "17.00(Cr)"
    s = s.replace(',', '')
    s = re.sub(r'\s+', '', s)
    try:
        return float(s)
    except ValueError:
        return value


# Bank statements commonly include a standalone "Statement Summary" / "Account
# Summary" box (Opening Balance, Dr/Cr Count, Total Debits/Credits, Closing
# Balance) somewhere on the page, separate from the actual transaction table.
# It's not a transaction and must never be extracted as one. Checking only the
# table's first row misses layouts where a title row precedes the summary's
# own label row (e.g. "Statement Summary as on ..." followed by
# "Opening Balance | Dr Count | ... | Closing Balance" as row 2), so scan the
# whole table's text instead of just row 0.
SUMMARY_TABLE_PHRASES = [
    'statement summary', 'account summary', 'summary as on',
    'opening balance', 'closing balance', 'total debit', 'total credit',
    'dr count', 'cr count',
]


def is_summary_table(table):
    if not table:
        return False
    table_text = ' '.join(str(c).lower() for row in table for c in row if c)
    return any(p in table_text for p in SUMMARY_TABLE_PHRASES)


def detect_header(table, target_headers):
    for i, row in enumerate(table):
        row_text = ' '.join([str(c).lower() for c in row if c])
        block = table[i:min(i+3, len(table))]
        joined_text = ' '.join([str(c).lower() for r in block for c in r if c])
        matches = sum(1 for t in target_headers if t in joined_text)
        has_date = 'date' in joined_text
        
        # Ensure the current row actually contains some of the header keywords
        # otherwise we might just be looking at the row BEFORE the header
        row_matches = sum(1 for t in target_headers if t in row_text)
        
        if has_date and matches >= 2 and row_matches >= 1:
            col_names = [str(c).replace('\n', ' ').strip() if c else f'Column_{j}' for j, c in enumerate(row)]
            return i, col_names
    return -1, None

def find_col_offset(first_row, main_headers):
    if not first_row:
        return 0, False
    row_lower = [str(c).strip().lower() if c else '' for c in first_row]
    headers_lower = [str(h).strip().lower() for h in main_headers]
    col_diff = len(main_headers) - len(first_row)
    if col_diff <= 0:
        return 0, False
    best_offset, best_matches = 0, 0
    for offset in range(col_diff + 1):
        if offset + len(row_lower) <= len(headers_lower):
            matches = sum(1 for i, cell in enumerate(row_lower) if cell and (cell in headers_lower[i + offset] or headers_lower[i + offset] in cell))
            if matches > best_matches:
                best_matches, best_offset = matches, offset
    if best_matches >= 2:
        return best_offset, True
    return 0, False

def split_crdr_column(df):
    crdr_col = None
    amount_col = None
    for col in df.columns:
        col_lower = str(col).lower()
        if 'cr/dr' in col_lower:
            crdr_col = col
        elif 'amount' in col_lower and 'balance' not in col_lower and 'available' not in col_lower:
            amount_col = col

    if crdr_col and amount_col:
        df['Credit'] = df.apply(lambda r: r[amount_col] if str(r[crdr_col]).upper().strip() == 'CR' else None, axis=1)
        df['Debit'] = df.apply(lambda r: r[amount_col] if str(r[crdr_col]).upper().strip() == 'DR' else None, axis=1)
        df.drop(columns=[crdr_col, amount_col], inplace=True)
    return df


CRDR_INLINE_RE = re.compile(r'\(?\s*(?:dr|cr)\s*\)?\.?\s*$', re.IGNORECASE)


def split_embedded_crdr_amount(df):
    """
    Some statements (e.g. passbook-style exports) have a single Amount column
    with the direction embedded in each cell instead of a separate Cr/Dr
    column — e.g. "17.00(Cr)" / "236.00(Dr)". Left alone, that direction is
    lost the moment the amount is converted to a plain float. Detect that
    pattern and split it into proper Debit/Credit columns before any numeric
    cleanup runs, so the sign survives.
    """
    if any('cr/dr' in str(c).lower() for c in df.columns):
        return df  # already has an explicit Cr/Dr column — split_crdr_column handles it

    for col in list(df.columns):
        col_lower = str(col).lower()
        if 'amount' not in col_lower or 'balance' in col_lower or 'available' in col_lower:
            continue

        values = df[col].astype(str)
        non_blank = values[values.str.strip() != '']
        if non_blank.empty:
            continue
        marked_ratio = non_blank.str.contains(CRDR_INLINE_RE).mean()
        if marked_ratio < 0.6:
            continue  # doesn't look like an inline-direction amount column

        def parse_amt(v):
            s = str(v).strip()
            m = re.search(r'(dr|cr)', s, flags=re.IGNORECASE)
            num = clean_numeric(s)
            if not isinstance(num, (int, float)):
                return (None, None)
            direction = m.group(1).lower() if m else None
            if direction == 'dr':
                return (num, None)
            if direction == 'cr':
                return (None, num)
            return (None, None)

        parsed = df[col].apply(parse_amt)
        df['Debit'] = parsed.apply(lambda t: t[0])
        df['Credit'] = parsed.apply(lambda t: t[1])
        df.drop(columns=[col], inplace=True)

    return df

# =================================================================
# Main parser (HYBRID MODE: Text + OCR)
# =================================================================

def parse_bank_statement(file_path, output_excel_path):
    print(f"\n--- Loading File: {file_path} ---")

    target_headers = [
        "date", "txn date", "transaction date", "value date", "posting date",
        "balance", "amount", "withdrawal", "deposit", "value date",
        "narration", "txn", "transaction", "category", "chq", "cheque", "ref", "particulars", "remarks"
    ]
    
    pages_tables = []
    is_native_pdf = False
    ext = file_path.lower().rsplit('.', 1)[-1]
    
    # ── Auto-Detect Document Engine ──────────────────────────────────────
    if ext == 'pdf':
        with pdfplumber.open(file_path) as pdf:
            if len(pdf.pages) > 0:
                text = pdf.pages[0].extract_text() or ""
                # If there's selectable text, use native, fast pdfplumber
                if len(text.strip()) > 50:
                    is_native_pdf = True
                    print("[+] Native PDF detected. Using fast data extraction.")
                    ts_lines = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}
                    ts_text = {"horizontal_strategy": "text", "snap_x_tolerance": 10}
                    
                    p0_lines = pdf.pages[0].extract_tables(table_settings=ts_lines)
                    
                    if p0_lines and (len(p0_lines) > 5 or any(len(t) >= 3 and len(t[0]) >= 4 for t in p0_lines)):
                        print("    -> Detected explicit gridlines.")
                        ts = ts_lines
                    else:
                        explicit_cols = get_explicit_columns(pdf.pages[0], target_headers)
                        if explicit_cols and len(explicit_cols) > 3:
                            print("    -> No gridlines. Using smart header-aligned column boundaries.")
                            ts = {
                                "vertical_strategy": "explicit",
                                "explicit_vertical_lines": explicit_cols,
                                "horizontal_strategy": "text",
                                "snap_x_tolerance": 5,
                                "intersection_x_tolerance": 1500
                            }
                        else:
                            print("    -> No gridlines or clear headers. Using text strategy.")
                            ts = ts_text
                        
                    for page in pdf.pages:
                        pages_tables.append(page.extract_tables(table_settings=ts))

    if not is_native_pdf:
        print("[!] Image or Scanned PDF detected. Engaging Universal OCR Engine...")
        try:
            if ext == 'pdf':
                images = convert_from_path(file_path)
            else:
                img = cv2.imread(file_path)
                images = [img] if img is not None else []
                
            for idx, img in enumerate(images):
                print(f"   -> Running OCR on Page {idx+1}/{len(images)}...")
                tables = extract_tables_with_ocr(img)
                pages_tables.append(tables)
        except Exception as e:
            print(f"[ERROR] OCR Engine Failed: {e}")
            print("Ensure Tesseract-OCR and Poppler are installed on your computer.")
            return False

    # ── Map Tables to Transactions ────────────────────────────────────────
    all_data = []
    headers = None

    p0_tables = pages_tables[0] if pages_tables else []
    one_table_per_txn = (len(p0_tables) > 5 and len(p0_tables) > 1 and all(len(t) <= 8 for t in p0_tables[1:min(6, len(p0_tables))]))

    # Check if data appears fragmented (too many single/double-cell rows)
    # If so, use the word-coordinate extractor for accurate results
    if is_native_pdf and not one_table_per_txn:
        all_flat = [row for tables in pages_tables for table in tables for row in table]
        if all_flat:
            empty_ratio = sum(1 for row in all_flat if sum(1 for c in row if c and str(c).strip()) <= 2) / len(all_flat)
            if empty_ratio > 0.35:
                print("    -> High fragmentation detected. Switching to word-coordinate extractor.")
                coord_headers, coord_rows = extract_transactions_by_word_coords(file_path, target_headers)
                if coord_headers and coord_rows:
                    headers = coord_headers
                    all_data = coord_rows
                    print(f"    -> Word-coordinate extractor found {len(coord_rows)} transactions.")

    coord_extractor_succeeded = headers is not None and bool(all_data)
    tables_to_process = [] if coord_extractor_succeeded else pages_tables  # Skip entirely if word-coord extractor already filled data

    for tables in tables_to_process:
        if one_table_per_txn:
            # ICICI-style logic
            for table in tables:
                if not table: continue
                h_idx, h_names = detect_header(table, target_headers)
                if h_idx != -1:
                    if headers is None:
                        end = min(h_idx + 3, len(table))
                        headers = merge_multirow_header(table[h_idx:end])
                    continue
                if headers is None: continue
                # No header found in this table AND it looks like a standalone
                # summary box (Opening/Closing Balance, Dr/Cr Count, etc.) rather
                # than a single-transaction table — not a real transaction.
                if is_summary_table(table): continue

                row = collapse_table_to_row(table)
                if not any(v.strip() for v in row): continue
                if len(row) < len(headers):
                    row.extend([''] * (len(headers) - len(row)))
                elif len(row) > len(headers):
                    row = row[:len(headers)]
                all_data.append(row)
        else:
            # Standard style logic
            for table in tables:
                if not table: continue
                h_idx, h_names = detect_header(table, target_headers)
                if h_idx != -1 and headers is None:
                    headers = h_names
                if headers is None: continue

                start_row = h_idx + 1 if h_idx != -1 else 0
                col_offset = 0

                if h_idx != -1:
                    while start_row < len(table):
                        sub_row = [str(c).strip().lower() for c in table[start_row] if c]
                        if not sub_row or (any(w in sub_row for w in ['date', 'no', 'description']) and not any(any(char.isdigit() for char in cell) for cell in sub_row)):
                            start_row += 1
                        else:
                            break
                else:
                    # This table has no recognized transaction header of its own.
                    # If it also looks like a standalone summary box (Opening/
                    # Closing Balance, Dr/Cr Count, etc.) it isn't a continuation
                    # of the real transaction table — skip it entirely rather
                    # than risk splicing its cells in as a bogus transaction.
                    if is_summary_table(table): continue
                    col_diff = len(headers) - len(table[0])
                    if col_diff < -1 or col_diff > 3: continue
                    if col_diff > 0:
                        offset, skip_row = find_col_offset(table[0], headers)
                        if not skip_row and offset == 0: continue
                        col_offset = offset
                        if skip_row: start_row = 1

                current_txn = None
                for row in table[start_row:]:
                    clean_row = [str(c).replace('\n', ' ').strip() if c else '' for c in row]
                    if not any(clean_row): continue
                    if col_offset > 0: clean_row = [''] * col_offset + clean_row
                    
                    if len(clean_row) < len(headers):
                        clean_row.extend([''] * (len(headers) - len(clean_row)))
                    elif len(clean_row) > len(headers):
                        clean_row = clean_row[:len(headers)]

                    non_empty_count = sum(1 for c in clean_row if c)
                    is_new_txn = bool(clean_row[0]) or non_empty_count >= 3

                    if is_new_txn:
                        if current_txn: all_data.append(current_txn)
                        current_txn = clean_row
                    else:
                        target = current_txn if current_txn else (all_data[-1] if all_data else None)
                        if target is not None:
                            for idx in range(min(len(clean_row), len(target))):
                                if clean_row[idx]:
                                    target[idx] = (target[idx] + ' ' + clean_row[idx]).strip()

                if current_txn:
                    all_data.append(current_txn)

    # ── Build DataFrame and Export ───────────────────────────────────────
    if not all_data:
        print("No transactional data found. Check the document format.")
        return False

    if headers is None:
        num_cols = max(len(r) for r in all_data)
        headers = [f"Column_{i + 1}" for i in range(num_cols)]

    df = pd.DataFrame(all_data, columns=headers)
    df = split_embedded_crdr_amount(df)  # must run before numeric cleanup strips the Dr/Cr direction
    amount_keywords = ['amt', 'amount', 'balance', 'debit', 'credit', 'withdrawal', 'deposit']
    for col in df.columns:
        col_lower_no_spaces = str(col).lower().replace(' ', '').replace('\n', '')
        if any(kw in col_lower_no_spaces for kw in amount_keywords) and 'cr/dr' not in col_lower_no_spaces:
            df[col] = df[col].apply(clean_numeric)
            df[col] = pd.to_numeric(df[col], errors='coerce')

    df = split_crdr_column(df)

    # ── Clean Date column: extract only the date, prepend overflow to narration ──
    date_col = next((c for c in df.columns if str(c).lower().strip() in ('date', 'transaction date', 'txn date', 'value date') and 'value' not in str(c).lower()), None)
    narr_col = next((c for c in df.columns if any(kw in str(c).lower() for kw in ('detail', 'narration', 'particulars', 'description', 'transaction'))), None)

    if date_col and narr_col:
        DATE_RE = re.compile(r'\d{1,2}[/-]\d{1,2}[/-]\d{2,4}')
        def split_date_narr(row):
            raw = str(row[date_col]).strip() if pd.notna(row[date_col]) else ''
            m = DATE_RE.search(raw)
            if m:
                date_val = m.group(0)
                overflow = (raw[:m.start()] + ' ' + raw[m.end():]).strip()
                narr_val = str(row[narr_col]).strip() if pd.notna(row[narr_col]) else ''
                if overflow:
                    narr_val = (overflow + ' ' + narr_val).strip()
                return date_val, narr_val
            return raw, str(row[narr_col]).strip() if pd.notna(row[narr_col]) else ''

        df[[date_col, narr_col]] = df.apply(
            lambda r: pd.Series(split_date_narr(r)), axis=1
        )

    # Drop non-transactional rows: bare "B/F"/"Brought Forward" opening-balance
    # lines, and rows with neither a date nor any narration text (nothing to
    # identify them as a real transaction). Applies to every extraction path
    # (OCR, ICICI-style, standard-style, word-coordinate) since it runs on the
    # final DataFrame, not inside any one extractor.
    if narr_col:
        is_bf_row = df[narr_col].astype(str).str.contains(
            r'\bb\s*/\s*f\b|brought forward', case=False, regex=True, na=False
        )
        df = df[~is_bf_row]

        # Same treatment for "Closing Balance" / "Opening Balance" carry-forward
        # markers: these are summary labels, not real transactions. This catches
        # the case where such a line rides along as its own row inside an
        # otherwise-real transaction table (is_summary_table only discards a
        # whole table when it has no real header — a single closing/opening
        # balance row embedded in a legitimate table still needs this net).
        is_balance_marker_row = df[narr_col].astype(str).str.contains(
            r'closing balance|opening balance', case=False, regex=True, na=False
        )
        df = df[~is_balance_marker_row]

    if date_col and narr_col:
        date_blank = df[date_col].isna() | (df[date_col].astype(str).str.strip() == '')
        narr_blank = df[narr_col].isna() | (df[narr_col].astype(str).str.strip() == '')
        df = df[~(date_blank & narr_blank)]

    # Filter out non-transactional junk (rows where ALL amount columns are NaN/empty)
    final_amount_cols = [
        col for col in df.columns 
        if any(kw in str(col).lower().replace(' ', '').replace('\n', '') for kw in amount_keywords)
        and 'cr/dr' not in str(col).lower().replace(' ', '').replace('\n', '')
    ]
    if final_amount_cols:
        df.dropna(subset=final_amount_cols, how='all', inplace=True)

    df.replace("", pd.NA, inplace=True)
    df.dropna(how='all', inplace=True)

    df.to_excel(output_excel_path, index=False, engine='openpyxl')
    
    wb = load_workbook(output_excel_path)
    ws = wb.active
    for col in ws.columns:
        max_len = 0
        col_letter = col[0].column_letter
        for cell in col:
            try:
                if cell.value is not None:
                    max_len = max(max_len, len(str(cell.value)))
            except Exception:
                pass
        ws.column_dimensions[col_letter].width = min(max_len + 2, 50)
    wb.save(output_excel_path)
    
    json_path = output_excel_path.rsplit('.', 1)[0] + '.json'
    df.to_json(json_path, orient='records', indent=4)
    
    print(f"[Success] Data extracted and saved to {output_excel_path} and {json_path}")
    return True

# =================================================================
# Entry point
# =================================================================

if __name__ == "__main__":
    import sys
    from datetime import datetime

    # Usage: python parse_bank_statement.py [input_file] [output_excel_path]
    # Called with explicit paths by src/lib/pythonBankParser.ts (the Next.js
    # app's subprocess wrapper). With no arguments, behaves exactly as before —
    # falls back to the original standalone default (uno.pdf) for manual runs.
    if len(sys.argv) >= 2:
        FILE_PATH = sys.argv[1]
    else:
        FILE_PATH = "uco.pdf"  # Put ANY file type here: Native PDF, Scanned PDF, .jpg, .png

    if not os.path.exists(FILE_PATH):
        print(f"File not found: {FILE_PATH}. Please provide a valid file path.")
        sys.exit(1)

    if len(sys.argv) >= 3:
        EXCEL_OUTPUT_PATH = sys.argv[2]
    else:
        file_stem = os.path.splitext(os.path.basename(FILE_PATH))[0]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        EXCEL_OUTPUT_PATH = f"{file_stem}_{timestamp}.xlsx"

    start_time = time.time()
    try:
        success = parse_bank_statement(FILE_PATH, EXCEL_OUTPUT_PATH)
    except PermissionError:
        print(f"\n[ERROR] Cannot write to '{EXCEL_OUTPUT_PATH}'. Please close it in Excel.")
        sys.exit(1)
    else:
        elapsed = time.time() - start_time
        if success:
            print(f"Extraction completed in {elapsed:.2f} seconds.")
            sys.exit(0)
        else:
            sys.exit(1)