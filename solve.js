// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for input {text, header}, per its broken-row policy:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, each CRLF or lone CR inside it read as LF; what
//     follows its closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts
//     on (every LF, CRLF and lone CR inside a quoted field counted), row its
//     record's index in rows (null for the header), in the order met.
//
// Speed: fields are cut out with slice() instead of built character by
// character; quoted fields are located with indexOf('"') and only fall back to
// segment building when they hold a doubled quote or a CR. Pure: nothing is
// kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters an
  // unquoted read kept (the quote_junk test).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr).
  function readUnquoted(value) {
    let start = pos;
    let i = pos;
    let parts = null; // kept segments, only when a stray CR splits the field
    let kept = 0; // characters kept before the current segment
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44) { // ,
        fValue = finishUnquoted(value, parts, start, i);
        fAdded = kept + (i - start);
        pos = i + 1;
        fEnded = COMMA;
        return;
      }
      if (c === 10) { // LF
        fValue = finishUnquoted(value, parts, start, i);
        fAdded = kept + (i - start);
        pos = i + 1;
        line += 1;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13) { // CR
        if (i + 1 < len && text.charCodeAt(i + 1) === 10) {
          fValue = finishUnquoted(value, parts, start, i);
          fAdded = kept + (i - start);
          pos = i + 2;
          line += 1;
          fEnded = LINE_BREAK;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        if (i > start) parts.push(text.slice(start, i));
        kept += i - start;
        i += 1;
        start = i;
        continue;
      }
      i += 1;
    }
    fValue = finishUnquoted(value, parts, start, len);
    fAdded = kept + (len - start);
    pos = len;
    fEnded = END;
  }

  function finishUnquoted(value, parts, start, end) {
    if (parts === null) {
      return value === '' ? text.slice(start, end) : value + text.slice(start, end);
    }
    if (end > start) parts.push(text.slice(start, end));
    return value === '' ? parts.join('') : value + parts.join('');
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;
    const q = text.indexOf('"', start);
    if (q !== -1 && !(q + 1 < len && text.charCodeAt(q + 1) === 34)) {
      // Fast path: a single closing quote. The content is one slice unless it
      // holds a CR (each CRLF or lone CR inside quotes is read as LF).
      const value = text.slice(start, q);
      if (value.indexOf('\r') === -1) {
        // Count the LFs inside for the line number.
        let n = value.indexOf('\n');
        while (n !== -1) {
          line += 1;
          n = value.indexOf('\n', n + 1);
        }
        pos = q + 1;
        finishQuoted(value);
        return;
      }
    }
    readQuotedSlow(open, openLine, start);
  }

  // The quoted field holds a doubled quote or a CR, or never closes: build it
  // from segments between quotes.
  function readQuotedSlow(open, openLine, start) {
    const parts = [];
    let i = start;
    let l = openLine;
    while (true) {
      const q = text.indexOf('"', i);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      // Segment [i, q): CRLF and lone CR each become one LF; every LF, CRLF
      // and lone CR counts a line.
      let seg = text.slice(i, q);
      if (seg.indexOf('\r') !== -1) {
        seg = seg.replace(/\r\n?/g, '\n');
      }
      let n = seg.indexOf('\n');
      while (n !== -1) {
        l += 1;
        n = seg.indexOf('\n', n + 1);
      }
      parts.push(seg);
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        parts.push('"');
        i = q + 2;
        continue;
      }
      line = l;
      pos = q + 1;
      finishQuoted(parts.join(''));
      return;
    }
  }

  // After a closing quote: the field ends at a comma or line break, or what
  // follows is appended as it stands (quote_junk, when the field ends).
  function finishQuoted(value) {
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
