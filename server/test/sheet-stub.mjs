/**
 * SpreadsheetApp.create, faked well enough for Report.gs to build its
 * workbook in the Apps Script harness: every value, merge, style, width and
 * freeze it sets is kept, so report.test.mjs can hold the workbook built in
 * Node to it cell for cell.
 *
 * It refuses what Sheets refuses where Report.gs has met it: a block of
 * values whose shape differs from its range, a sheet name already taken
 * (Sheets ignores case), and a freeze that would cut a merged cell.
 */
export function spreadsheetStub() {
  const books = [];

  function sheetOf(name) {
    const sheet = {
      name,
      cells: new Map(),
      merges: [],
      widths: {},
      frozenRows: 0,
      frozenColumns: 0,
    };
    const cell = (row, column) => {
      const key = `${row},${column}`;
      if (!sheet.cells.has(key)) sheet.cells.set(key, { style: {} });
      return sheet.cells.get(key);
    };
    const cuts = (count, along) =>
      sheet.merges.some((m) =>
        along === "columns"
          ? m.left <= count && count < m.right
          : m.top <= count && count < m.bottom,
      );
    sheet.api = {
      getName: () => sheet.name,
      getRange(row, column, rows = 1, columns = 1) {
        const each = (work) => {
          for (let r = row; r < row + rows; r++)
            for (let c = column; c < column + columns; c++) work(cell(r, c));
        };
        const style = (key, value) => {
          each((target) => {
            target.style[key] = value;
          });
          return range;
        };
        const range = {
          merge() {
            sheet.merges.push({
              top: row,
              left: column,
              bottom: row + rows - 1,
              right: column + columns - 1,
            });
            return range;
          },
          setValue(value) {
            each((target) => {
              target.value = value;
            });
            return range;
          },
          setValues(grid) {
            if (
              grid.length !== rows ||
              grid.some((line) => line.length !== columns)
            )
              throw new Error(
                `The number of rows or columns in the data does not match the range (${rows}×${columns}).`,
              );
            grid.forEach((line, i) =>
              line.forEach((value, j) => {
                cell(row + i, column + j).value = value;
              }),
            );
            return range;
          },
          setFontWeight: (value) => style("bold", value === "bold"),
          setFontStyle: (value) => style("italic", value === "italic"),
          setFontSize: (value) => style("size", value),
          setFontColor: (value) => style("color", value),
          setBackground: (value) => style("fill", value),
          setHorizontalAlignment: (value) => style("horizontal", value),
          setVerticalAlignment: (value) => style("vertical", value),
          setWrap: (value) => style("wrap", value),
          setNumberFormat: (value) => style("format", value),
        };
        return range;
      },
      setColumnWidth(column, pixels) {
        sheet.widths[column] = pixels;
      },
      setFrozenColumns(count) {
        if (cuts(count, "columns"))
          throw new Error(
            "You can't freeze columns which contain only part of a merged cell.",
          );
        sheet.frozenColumns = count;
      },
      setFrozenRows(count) {
        if (cuts(count, "rows"))
          throw new Error(
            "You can't freeze rows which contain only part of a merged cell.",
          );
        sheet.frozenRows = count;
      },
    };
    return sheet;
  }

  function create(name) {
    const book = { id: `sheet-${books.length + 1}`, name, sheets: [] };
    book.sheets.push(sheetOf("Sheet1"));
    books.push(book);
    return {
      getId: () => book.id,
      getName: () => book.name,
      getSheets: () => book.sheets.map((sheet) => sheet.api),
      getSheetByName: (wanted) =>
        book.sheets.find((sheet) => sheet.name === wanted)?.api || null,
      insertSheet(sheetName, index) {
        if (
          book.sheets.some(
            (sheet) => sheet.name.toUpperCase() === sheetName.toUpperCase(),
          )
        )
          throw new Error(
            `A sheet with the name "${sheetName}" already exists. Please enter another name.`,
          );
        const sheet = sheetOf(sheetName);
        if (index == null) book.sheets.push(sheet);
        else book.sheets.splice(index, 0, sheet);
        return sheet.api;
      },
      deleteSheet(api) {
        book.sheets.splice(
          book.sheets.findIndex((sheet) => sheet.api === api),
          1,
        );
      },
    };
  }

  return { create, books };
}
