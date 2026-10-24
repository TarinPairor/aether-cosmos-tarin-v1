import path from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { credentialPaths, jsonRequest } from './google.js';
import { AppError } from './errors.js';
import { DEFAULT_SHEET_ID } from './intake-fields.js';

const canonical = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const column = index => { let s = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
export class SheetsService {
  constructor(root, store = null) {
    this.root = root;
    this.store = store;
    this.id = process.env.INTAKE_SPREADSHEET_ID || DEFAULT_SHEET_ID;
    this.gid = Number(process.env.INTAKE_SHEET_GID || 0);
  }
  async init() {
    const config = await this.store?.read('sheet-config');
    if (config && /^[\w-]{20,200}$/.test(config.id) && Number.isInteger(config.gid) && config.gid >= 0) { this.id = config.id; this.gid = config.gid; }
  }
  config() { return { id: this.id, gid: this.gid }; }
  parseLink(input) {
    let url;
    try { url = new URL(input); } catch { throw new AppError('Paste a valid Google Sheets link.'); }
    const match = url.hostname === 'docs.google.com' && url.pathname.match(/^\/spreadsheets\/d\/([\w-]{20,200})(?:\/|$)/);
    if (!match) throw new AppError('Paste a link from docs.google.com/spreadsheets.');
    const fragment = new URLSearchParams(url.hash.slice(1));
    const gid = fragment.has('gid') ? Number(fragment.get('gid')) : 0;
    if (!Number.isSafeInteger(gid) || gid < 0) throw new AppError('The sheet link has an invalid tab ID.');
    return { id: match[1], gid };
  }
  async connect(input) {
    const previous = this.config(), next = this.parseLink(input);
    if (this.store && (previous.id !== next.id || previous.gid !== next.gid)) {
      const sessions = await this.store.read('intakes', []);
      let changed = false;
      for (const session of sessions) if (!session.sheetConfig) { session.sheetConfig = previous; changed = true; }
      if (changed) await this.store.write('intakes', sessions);
    }
    this.id = next.id; this.gid = next.gid;
    try {
      const sheet = await this.inspect();
      await this.store?.write('sheet-config', next);
      return sheet;
    } catch (error) { this.id = previous.id; this.gid = previous.gid; throw error; }
  }
  async request(resource = '', options = {}, spreadsheetId = this.id) {
    if (!this.auth) {
      const paths = await credentialPaths(this.root);
      if (!paths.service) throw new AppError('The service account JSON is missing.');
      this.auth = new GoogleAuth({ keyFile: path.resolve(this.root, paths.service), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    }
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    try {
      return await jsonRequest(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}${resource}`, {
        ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
      });
    } catch (error) {
      if (/permission|forbidden|not found/i.test(error.message)) throw new AppError('Cannot access the intake spreadsheet. Share it with the service account as Editor and enable Google Sheets API in its project.');
      throw error;
    }
  }
  async read(config = this.config()) {
    const metadata = await this.request('?fields=properties(title),sheets(properties)', {}, config.id);
    const tab = metadata.sheets?.find(sheet => sheet.properties.sheetId === config.gid)?.properties;
    if (!tab) throw new AppError(`Spreadsheet tab gid=${config.gid} does not exist.`);
    const range = `'${tab.title.replaceAll("'", "''")}'`;
    const data = await this.request(`/values/${encodeURIComponent(range)}`, {}, config.id);
    const rows = data.values || [];
    const headerIndex = rows.slice(0, 20).findIndex(row => row.some(value => canonical(value) === 'email'));
    if (headerIndex < 0) throw new AppError('Could not find an Email header in the first 20 spreadsheet rows. Put the column names, including Email, together on one row.');
    const headers = rows[headerIndex] || [];
    const fields = headers.map(value => String(value || '').trim()).filter(Boolean);
    if (!fields.length) throw new AppError(`Add field names to row ${headerIndex + 1} of the spreadsheet.`);
    const map = Object.fromEntries(fields.map(field => [field, headers.findIndex(value => String(value || '').trim() === field)]));
    const duplicates = fields.filter((field, index) => fields.findIndex(other => canonical(other) === canonical(field)) !== index);
    if (duplicates.length) throw new AppError(`Row ${headerIndex + 1} contains duplicate field names: ${[...new Set(duplicates)].join(', ')}.`);
    if (map.Email === undefined) throw new AppError(`Row ${headerIndex + 1} must include an Email column so the app can match each person to their conversation.`);
    const firstDataRow = headerIndex + 2, lastRow = Math.max(firstDataRow, tab.gridProperties?.rowCount || rows.length);
    const lastColumn = column(Math.max(0, headers.length - 1));
    const gridParams = new URLSearchParams({ includeGridData: 'true',
      ranges: `${range}!A${firstDataRow}:${lastColumn}${lastRow}`,
      fields: 'sheets(properties(sheetId),data(rowData(values(dataValidation(condition(type,values))))))' });
    const grid = await this.request(`?${gridParams}`, {}, config.id);
    const rowData = grid.sheets?.find(item => item.properties?.sheetId === tab.sheetId)?.data?.[0]?.rowData || [];
    const validationByColumn = new Map();
    for (const row of rowData) for (let index = 0; index < (row.values || []).length; index++) {
      const validation = row.values[index]?.dataValidation, condition = validation?.condition;
      if (!condition || !['ONE_OF_LIST', 'ONE_OF_RANGE'].includes(condition.type)) continue;
      let options = condition.type === 'ONE_OF_LIST'
        ? (condition.values || []).map(item => item.userEnteredValue).filter(value => typeof value === 'string' && value !== '')
        : [];
      if (condition.type === 'ONE_OF_RANGE') {
        const reference = condition.values?.[0]?.userEnteredValue;
        const cleanReference = typeof reference === 'string' ? reference.replace(/^=/, '') : '';
        if (cleanReference && /^[\w' $!:.]+$/.test(cleanReference)) {
          const choices = await this.request(`/values/${encodeURIComponent(cleanReference)}`, {}, config.id);
          options = (choices.values || []).flat().map(value => String(value)).filter(Boolean);
        }
      }
      if (!options.length) throw new AppError(`Could not read the dropdown choices for column “${fields[index] || index + 1}”. Check its data validation source.`);
      const existing = validationByColumn.get(index) || new Set();
      for (const option of options) existing.add(option);
      validationByColumn.set(index, existing);
    }
    const dropdownOptions = Object.fromEntries([...validationByColumn].map(([index, options]) => [fields[index], [...options]]));
    return { title: metadata.properties?.title, tab, range, rows, map, fields, headerIndex, headerRow: headerIndex + 1, dropdownOptions };
  }
  async inspect(config = this.config()) {
    const sheet = await this.read(config);
    const dropdowns = Object.keys(sheet.dropdownOptions).length;
    return { title: sheet.title, tab: sheet.tab.title, fields: sheet.fields, dropdownOptions: sheet.dropdownOptions, headerRow: sheet.headerRow, rowCount: Math.max(0, sheet.rows.length - sheet.headerRow),
      url: `https://docs.google.com/spreadsheets/d/${config.id}/edit#gid=${config.gid}`, detail: `Found ${sheet.fields.length} fields in row ${sheet.headerRow}${dropdowns ? ` and ${dropdowns} dropdown columns` : ''}. Writing requires Editor access; no test cells were written.` };
  }
  find(sheet, personId, email) {
    const matches = sheet.rows.slice(sheet.headerIndex + 1).flatMap((row, index) => {
      const id = sheet.map['Person ID'] === undefined ? '' : String(row[sheet.map['Person ID']] || '');
      const sameId = personId && id === personId;
      const sameEmail = String(row[sheet.map.Email] || '').trim().toLowerCase() === email.toLowerCase();
      return sameId || sameEmail ? [{ row: index + sheet.headerRow + 1, values: row }] : [];
    });
    if (matches.length > 1) throw new AppError('Multiple spreadsheet rows match this person. Resolve the duplicate Person ID or Email before continuing.');
    return matches[0] || null;
  }
  async lookup(email, config = this.config()) {
    const sheet = await this.read(config), match = this.find(sheet, null, email);
    const profile = match ? Object.fromEntries(sheet.fields.map(field => [field, String(match.values[sheet.map[field]] ?? '')])) : {};
    return { profile, row: match?.row || null, fields: sheet.fields, dropdownOptions: sheet.dropdownOptions };
  }
  async upsert(profile, config = this.config()) {
    const sheet = await this.read(config), match = this.find(sheet, profile['Person ID'], profile.Email);
    if (match) {
      const existingId = String(match.values[sheet.map['Person ID']] || '');
      if (existingId && existingId !== profile['Person ID']) throw new AppError('The matching email has a different Person ID. Resolve the conflict before writing.');
    }
    const row = match?.row || Math.max(sheet.headerRow + 1, sheet.rows.length + 1);
    if (row > sheet.tab.gridProperties.rowCount) throw new AppError('This spreadsheet tab has no empty rows. Add more rows and resume the intake.');
    const data = sheet.fields.filter(field => {
      if (profile[field] === undefined || !String(profile[field]).trim()) return false;
      const options = sheet.dropdownOptions[field];
      return !options || options.includes(String(profile[field]));
    }).map(field => ({
      range: `${sheet.range}!${column(sheet.map[field])}${row}`, values: [[field === 'Age' && /^\d+$/.test(profile[field]) ? Number(profile[field]) : String(profile[field])]],
    }));
    await this.request('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) }, config.id);
    return { row, url: `https://docs.google.com/spreadsheets/d/${config.id}/edit#gid=${config.gid}&range=A${row}` };
  }
}
