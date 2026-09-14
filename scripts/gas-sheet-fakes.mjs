// Shared fake Sheet/Spreadsheet/SpreadsheetApp helpers for testing
// gas/review_queue.js and anything that reads/writes through it
// (autonomous_agent.js's enqueue path, recursive_learning.js's enqueue
// path, the harvest functions themselves) - one implementation, not a
// copy per test file, so a fix to the fake shape doesn't have to be made
// three times.
//
// Mirrors just the real Sheet/Spreadsheet/SpreadsheetApp surface this
// project's code actually calls: getDataRange().getValues(), appendRow(),
// getRange(row, col).setValue(), getSheetByName(), insertSheet(),
// SpreadsheetApp.openById(), SpreadsheetApp.flush().

export function makeFakeSheet(rows = []) {
  const data = rows.map((r) => r.slice());
  return {
    _rows: data,
    appendRow(values) {
      data.push(values.slice());
    },
    getDataRange() {
      return { getValues: () => data.map((r) => r.slice()) };
    },
    getRange(rowNum, colNum) {
      return {
        setValue(v) {
          data[rowNum - 1][colNum - 1] = v;
        }
      };
    }
  };
}

export function makeFakeSpreadsheet(initialSheets = {}) {
  const sheets = { ...initialSheets };
  return {
    _sheets: sheets,
    getSheetByName(name) {
      return sheets[name] || null;
    },
    insertSheet(name) {
      const s = makeFakeSheet();
      sheets[name] = s;
      return s;
    }
  };
}

// Seed for loadGasGlobals(...) - a { id: fakeSpreadsheet } map, so a test
// can control exactly what SpreadsheetApp.openById(id) returns.
export function makeFakeSpreadsheetApp(spreadsheetsById = {}) {
  return {
    openById(id) {
      if (!spreadsheetsById[id]) throw new Error(`no fake spreadsheet registered for id ${id}`);
      return spreadsheetsById[id];
    },
    flush() {}
  };
}

export function makeFakeLogger() {
  const lines = [];
  return { lines, log: (msg) => lines.push(msg) };
}
