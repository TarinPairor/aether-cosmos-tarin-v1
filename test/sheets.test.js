import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetsService } from '../lib/sheets.js';
import { FIELDS } from '../lib/intake-fields.js';
function fixture(headers=FIELDS) {
 const service=new SheetsService('.'), calls=[], rows=[[...headers]];
 service.request=async(resource,options={})=>{
   calls.push({resource,options});
   if(resource.startsWith('?')) return {properties:{title:'People'},sheets:[{properties:{sheetId:0,title:"People's profiles",gridProperties:{rowCount:1000}}}]};
   if(resource==='/values:batchUpdate') {
     const body=JSON.parse(options.body); assert.equal(body.valueInputOption,'RAW');
     for(const item of body.data){ const match=item.range.match(/!([A-Z]+)(\d+)$/); const column=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1; const row=Number(match[2])-1; rows[row] ||= []; rows[row][column]=item.values[0][0]; }
     return {totalUpdatedCells:body.data.length};
   }
   if(resource.startsWith('/values/')) return {values:structuredClone(rows)};
   throw new Error('Unexpected resource');
 };
 return {service,calls,rows};
}
test('maps reordered named columns and preserves unrelated cells and leading zeros',async()=>{
 const {service,rows,calls}=fixture([...FIELDS].reverse().concat('Notes'));
 rows.push([]); rows[1][rows[0].indexOf('Notes')]='keep this note';
 const profile={'Person ID':'person-1',Email:'maya@example.com','First Name':'Maya',Age:'28',Phone:'+65 0123 4567','Postal Code':'00123',Company:'=IMPORTDATA("https://example.com")'};
 const first=await service.upsert(profile);
 assert.equal(first.row,3); // Existing note-only row is preserved.
 const row=rows[2];
 for(const [field,value]of Object.entries(profile)) assert.equal(row[rows[0].indexOf(field)],field==='Age'?28:value);
 assert.equal(rows[1][rows[0].indexOf('Notes')],'keep this note');
 const second=await service.upsert({...profile,City:'Singapore'}); assert.equal(second.row,3); assert.equal(rows.length,3);
 assert.equal(rows[2][rows[0].indexOf('City')],'Singapore');
 assert.match(JSON.parse(calls.find(c=>c.resource==='/values:batchUpdate').options.body).data[0].range, /^'People''s profiles'!/);
});
test('duplicate headers and a missing Email identity column cause no writes',async()=>{
 for(const headers of [[...FIELDS,'Phone'],FIELDS.filter(f=>f!=='Email')]){
   const {service,calls}=fixture(headers);
   await assert.rejects(()=>service.upsert({'Person ID':'p1',Email:'x@example.com'}),headers.includes('Email')?/duplicate field names/:/must include an Email column/);
   assert.equal(calls.some(c=>c.resource==='/values:batchUpdate'),false);
 }
});
test('existing email reuses the same Person ID and row, and duplicate matches are refused',async()=>{
 const {service,rows,calls}=fixture();
 const row=[];row[rows[0].indexOf('Person ID')]='existing-id';row[rows[0].indexOf('Email')]='maya@example.com'; rows.push(row);
 const found=await service.lookup('MAYA@example.com'); assert.equal(found.profile['Person ID'],'existing-id'); assert.equal(found.row,2);
 await assert.rejects(()=>service.upsert({'Person ID':'other-id',Email:'maya@example.com'}),/different Person ID/);
 rows.push(structuredClone(row));
 await assert.rejects(()=>service.lookup('maya@example.com'),/Multiple spreadsheet rows/);
 assert.equal(calls.some(c=>c.resource==='/values:batchUpdate'),false);
});
test('checking spreadsheet is read-only and reports all expected headers',async()=>{
 const {service,calls}=fixture(); const result=await service.inspect();
 assert.equal(result.fields.length,20); assert.equal(result.rowCount,0); assert.equal(result.title,'People');
 assert.equal(calls.some(c=>c.options.method==='POST'),false);
});
test('spreadsheet header names define arbitrary intake fields',async()=>{
 const headers=['Email','Full Name','Preferred Contact','Favorite Color'];
 const {service,rows}=fixture(headers);rows[0]=headers;rows.push(['maya@example.com','Maya Chen','Email','Green']);
 const found=await service.lookup('maya@example.com');
 assert.deepEqual(found.fields,headers);assert.equal(found.profile['Favorite Color'],'Green');
 assert.deepEqual((await service.inspect()).fields,headers);
 await service.upsert({...found.profile,'Preferred Contact':'Text'});
 assert.equal(rows[1][2],'Text');
});
