/**
 * Minimal RFC 4180 CSV reader.
 *
 * Hand-rolled rather than pulled from npm because the input is one file a year,
 * typed by one person, and the failure mode that matters is a quoted team name
 * with a comma in it ("Kanata Major A, Black"). That is thirty lines of code
 * and a test, and it means the import path has no supply chain.
 */
export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM — Excel adds one on "Save as CSV".
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };

  const endRow = () => {
    endField();
    // Drop rows that are entirely empty — trailing newlines, blank separators.
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r') {
      // Handled by the \n that follows; a lone \r also ends the row.
      if (input[i + 1] !== '\n') endRow();
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
    }
  }

  // Final row, if the file didn't end with a newline.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Normalise a header cell so `Game ID`, `game_id`, `GAME-ID` and `Game #` all
 * land on the same key. Any run of non-alphanumeric characters becomes a single
 * underscore, and leading/trailing underscores are dropped — spreadsheet
 * headers collect `#`, `()` and stray punctuation, and none of it is meaningful.
 */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
