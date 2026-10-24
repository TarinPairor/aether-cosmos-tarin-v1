export const FIELDS = ['Person ID', 'First Name', 'Last Name', 'Age', 'Gender', 'Date of Birth', 'Email', 'Phone', 'Country', 'City', 'State', 'Postal Code', 'Address', 'Nationality', 'Occupation', 'Company', 'Department', 'Marital Status', 'Education', 'Employment Status'];
export const ANSWER_FIELDS = FIELDS.filter(field => !['Person ID', 'Email'].includes(field));
export const MAX_EMAILS = 5;
export const DEFAULT_SHEET_ID = '16M6CNZWDmPNXB-ZXz34uIN9xVzGvNbvoTPb5mmXE8TY';
export const answerFields = fields => fields.filter(field => !['personid', 'email'].includes(String(field).toLowerCase().replace(/[^a-z0-9]/g, '')));
export const missingFields = (profile, fields = FIELDS) => answerFields(fields).filter(field => !String(profile[field] || '').trim());
