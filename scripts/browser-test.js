import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Store } from '../lib/storage.js';
import { createApp } from '../lib/app.js';
import { IntakeService } from '../lib/intake.js';

const directory = await mkdtemp(path.join(tmpdir(), 'bananra-browser-'));
const store = new Store(directory);
await store.write('gmail-account', {email:'owner@example.com'});
const threads = new Map(), rows = new Map();
let sequence = 0, sends = 0;
const google = {
  hasService:true,hasOAuth:true,redirectConfigured:true,oauthKind:'web',redirect:'http://localhost:8081/oauth/callback',model:'test-model',backend:'vertex',
  canReadThreads:async()=>true,checkReadAccess:async()=>'Reading is available.',identity:async()=>({email:'owner@example.com'}),
  generate:async()=>({subject:'Test',body:'Connection works.'}),
  planIntake:async({incoming,continuation})=>({subject:'Hello',body:continuation?'Just checking in—would you like to share where you are based?\n\nBananra':incoming.length?'Thanks, Maya. Where are you based?\n\nBananra':'Hi, I’m Bananra, an assistant helping with your profile. What is your name?\n\nBananra',
    facts:incoming.flatMap(m=>m.body.includes('My first name is Maya.')?[{field:'First Name',value:'Maya',messageId:m.id,evidence:'My first name is Maya.'}]:[])}),
  listThreads:async()=>({threads:[...threads.values()].map(t=>({id:t.id,subject:t.subject,from:t.messages.at(-1).from,messageCount:t.messages.length,replyCount:t.messages.filter(m=>!m.sentByOwner).length})),nextPageToken:null}),
  getThread:async id=>structuredClone(threads.get(id)),
  send:async draft=>{
    sends++;const id='message-'+(++sequence),threadId=draft.threadId||'thread-'+sequence;
    const thread=threads.get(threadId)||{id:threadId,subject:draft.subject,messages:[]};
    thread.messages.push({id,from:'owner@example.com',to:draft.to,subject:draft.subject,body:draft.body,messageId:`<${id}@example.com>`,references:'',attachments:[],sentByOwner:true,date:'Today'});
    thread.version=thread.messages.map(m=>m.id).join('-');threads.set(threadId,thread);return{id,threadId,to:draft.to};
  },
};
const sheets={inspect:async()=>({title:'People',tab:'Profiles',detail:'All 20 column headers match.'}),lookup:async email=>({profile:rows.get(email)||{},row:rows.has(email)?2:null}),upsert:async profile=>{rows.set(profile.Email,structuredClone(profile));return{row:2,url:'https://example.com/profiles'};}};
const intake=new IntakeService({store,google,sheets});
const {server,tick}=createApp({root:process.cwd(),store,google,intake});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:8081/**',async route=>{
    const incoming=route.request(),req=Readable.from(incoming.postData()?[incoming.postData()]:[]);
    Object.assign(req,{method:incoming.method(),url:new URL(incoming.url()).pathname,headers:{...incoming.headers(),host:'localhost:8081'}});
    const response=await new Promise(resolve=>{const res={status:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(status,headers={}){this.status=status;Object.entries(headers).forEach(([k,v])=>this.setHeader(k,v));},end(body){resolve({status:this.status,headers:this.headers,body:body||''});}};server.emit('request',req,res);});
    await route.fulfill(response);
  });
  await page.goto('http://localhost:8081/');await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#compose-form').count(),0);
  await page.getByRole('button',{name:'Test connections'}).click();await page.getByText('All connections passed.',{exact:true}).waitFor();
  await page.getByLabel('Person’s email address').fill('person@example.com');
  await page.getByRole('button',{name:'Generate intro',exact:true}).click();await page.getByRole('button',{name:'Send intro',exact:true}).waitFor();assert.equal(sends,0);
  await page.getByRole('button',{name:'Send intro',exact:true}).click();await page.getByRole('button',{name:'Generate reply',exact:true}).waitFor();
  assert.equal(await page.locator('#sent-count').textContent(),'1 / 5');assert.equal(sends,1);
  // Explicit continuation works even before a recipient responds.
  await page.getByRole('button',{name:'Generate reply',exact:true}).click();await page.getByRole('button',{name:'Send reply',exact:true}).waitFor();assert.equal(sends,1);
  await page.getByRole('button',{name:'Send reply',exact:true}).click();await page.waitForFunction(()=>document.getElementById('sent-count').textContent==='2 / 5');
  let session=(await intake.list())[0];const thread=threads.get(session.threadId);
  thread.messages.push({id:'recipient-reply',from:'person@example.com',to:'owner@example.com',subject:'Re: '+thread.subject,body:'My first name is Maya.',messageId:'<recipient@example.com>',references:'',attachments:[],date:'Today'});thread.version+='-recipient';
  await tick();await page.reload();await page.waitForLoadState('networkidle');
  await page.waitForFunction(()=>document.getElementById('reply-count').textContent==='1');
  assert.equal(await page.locator('#sent-count').textContent(),'2 / 5');assert.equal(sends,2);
  await page.locator('#profile-details summary').click();assert.equal(rows.get('person@example.com')['First Name'],'Maya');
  await page.getByRole('button',{name:'New conversation',exact:true}).click();
  await page.locator('#thread-list button').filter({hasText:'person@example.com'}).click();
  await page.waitForFunction(()=>document.getElementById('reply-count').textContent==='1');assert.equal(await page.locator('#sent-count').textContent(),'2 / 5');
  assert.equal(await page.getByLabel('Send follow-ups automatically after recipient replies').isChecked(),false);
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  console.log('Dashboard workflows passed with simulated Google services: intro/reply transition, proactive continuation, recipient reply counts, selected thread continuation, profile sync, and no freeform composer. No real emails sent.');
}catch(error){console.error(error.message);console.error('Install a browser with npx playwright install chromium, or use PLAYWRIGHT_CHANNEL=chrome npm run test:browser.');process.exitCode=1;}
finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
