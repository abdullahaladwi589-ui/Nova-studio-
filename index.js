import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import Database from 'better-sqlite3';
import { fal } from '@fal-ai/client';
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || 'nova.db';
const db = new Database(DB_PATH);
const uploadDir = process.env.UPLOAD_DIR || 'uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || 'http://localhost:5173').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => !origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error('Origin not allowed')) }));

// Stripe webhook must receive the raw body before express.json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Webhook secret not configured');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated') {
      const obj = event.data.object;
      const email = obj.customer_details?.email || obj.metadata?.email;
      if (email) db.prepare('UPDATE users SET plan=? WHERE email=?').run('plus', email);
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const email = sub.metadata?.email;
      if (email) db.prepare('UPDATE users SET plan=? WHERE email=? AND plan=?').run('free', email, 'plus');
    }
    res.json({ received: true });
  } catch (e) { res.status(500).send('Webhook processing failed'); }
});

app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(uploadDir));

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,password TEXT,plan TEXT DEFAULT 'free',stripe_customer_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,user_id INTEGER,prompt TEXT,mode TEXT,status TEXT,video_url TEXT,model TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
`);

const setting = (key, fallback) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
if (!setting('plus_price_label')) setSetting('plus_price_label', process.env.PLUS_PRICE_LABEL || '1.99 USD / شهر');

const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
if (ownerEmail && !db.prepare('SELECT id FROM users WHERE email=?').get(ownerEmail)) {
  db.prepare('INSERT INTO users(email,password,plan) VALUES(?,?,?)').run(ownerEmail, bcrypt.hashSync(process.env.OWNER_PASSWORD || crypto.randomBytes(16).toString('hex'), 12), 'owner');
}

const secret = process.env.JWT_SECRET || 'dev-only-change-me';
function token(u) { return jwt.sign({ id: u.id, email: u.email, plan: u.plan }, secret, { expiresIn: '7d' }); }
function auth(req, res, next) {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), secret); next(); }
  catch { res.status(401).json({ error: 'تسجيل الدخول مطلوب' }); }
}
function ownerOnly(req, res, next) { if (req.user?.plan !== 'owner') return res.status(403).json({ error: 'هذه الصفحة للمالك فقط' }); next(); }
function usage(userId) { return db.prepare("SELECT count(*) c FROM jobs WHERE user_id=? AND date(created_at)=date('now')").get(userId).c; }

app.get('/api/health', (req,res) => res.json({ ok:true, service:'NOVA Studio', time:new Date().toISOString() }));
app.post('/api/auth/register', (req,res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({error:'استخدم بريدًا صحيحًا وكلمة مرور من 8 أحرف على الأقل'});
  try { const hash=bcrypt.hashSync(password,12); const r=db.prepare('INSERT INTO users(email,password) VALUES(?,?)').run(email,hash); res.json({token:token({id:r.lastInsertRowid,email,plan:'free'})}); }
  catch { res.status(409).json({error:'الحساب موجود بالفعل'}); }
});
app.post('/api/auth/login', (req,res) => { const email=String(req.body.email||'').trim().toLowerCase(); const u=db.prepare('SELECT * FROM users WHERE email=?').get(email); if(!u||!bcrypt.compareSync(String(req.body.password||''),u.password)) return res.status(401).json({error:'بيانات الدخول غير صحيحة'}); res.json({token:token(u),plan:u.plan}); });
app.get('/api/me',auth,(req,res)=>{ const u=db.prepare('SELECT id,email,plan FROM users WHERE id=?').get(req.user.id); const used=usage(u.id); res.json({...u,usedToday:used,limit:u.plan==='free'?1:null,plusPrice:setting('plus_price_label','1.99 USD / شهر')}); });

app.post('/api/billing/checkout', auth, async (req,res)=>{
  if (req.user.plan==='owner' || req.user.plan==='plus') return res.status(400).json({error:'الحساب لديه Plus بالفعل'});
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) return res.status(503).json({error:'الدفع غير مفعّل: أضف STRIPE_SECRET_KEY و STRIPE_PRICE_ID'});
  try {
    const stripe=new Stripe(process.env.STRIPE_SECRET_KEY); const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const session=await stripe.checkout.sessions.create({mode:'subscription',line_items:[{price:process.env.STRIPE_PRICE_ID,quantity:1}],customer_email:u.email,metadata:{email:u.email,user_id:String(u.id)},success_url:`${process.env.APP_URL}/?paid=1`,cancel_url:`${process.env.APP_URL}/?cancelled=1`});
    res.json({url:session.url});
  } catch(e){res.status(502).json({error:'تعذر إنشاء صفحة الدفع',detail:e.message});}
});

const upload=multer({dest:uploadDir,limits:{fileSize:Number(process.env.MAX_UPLOAD_MB||100)*1024*1024}});
app.post('/api/upload',auth,upload.single('file'),(req,res)=>{ if(!req.file)return res.status(400).json({error:'لم يتم رفع ملف'}); res.json({url:`${process.env.APP_URL||`http://localhost:${PORT}`}/uploads/${path.basename(req.file.path)}`}); });

app.post('/api/generate',auth,async(req,res)=>{
  const {prompt,mode='text-to-video',imageUrl,model=process.env.DEFAULT_VIDEO_MODEL||'fal-ai/wan/v2.2-a14b/image-to-video'}=req.body;
  if(!prompt)return res.status(400).json({error:'اكتب وصف الفيديو'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id); const used=usage(u.id);
  if(u.plan==='free' && used>=1)return res.status(429).json({error:'استهلكت فيديوك المجاني اليوم. Plus يفتح التوليد غير المحدود.'});
  if(!process.env.FAL_KEY)return res.status(503).json({error:'محرك الفيديو غير مفعّل. أضف FAL_KEY إلى الخادم.'});
  fal.config({credentials:process.env.FAL_KEY});
  const r=db.prepare('INSERT INTO jobs(user_id,prompt,mode,status,model) VALUES(?,?,?,?,?)').run(u.id,prompt,mode,'processing',model);
  try { const input={prompt,...(imageUrl?{image_url:imageUrl}: {})}; const result=await fal.subscribe(model,{input,logs:false}); const video=result?.data?.video?.url || result?.video?.url; db.prepare('UPDATE jobs SET status=?,video_url=? WHERE id=?').run(video?'completed':'failed',video||null,r.lastInsertRowid); res.json({jobId:r.lastInsertRowid,status:video?'completed':'failed',videoUrl:video||null}); }
  catch(e){db.prepare('UPDATE jobs SET status=? WHERE id=?').run('failed',r.lastInsertRowid);res.status(502).json({error:'فشل محرك التوليد',detail:e.message});}
});
app.get('/api/jobs',auth,(req,res)=>res.json(db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id)));

app.get('/api/admin/overview',auth,ownerOnly,(req,res)=>{const users=db.prepare('SELECT count(*) c FROM users').get().c;const plus=db.prepare("SELECT count(*) c FROM users WHERE plan='plus'").get().c;const jobs=db.prepare('SELECT count(*) c FROM jobs').get().c;res.json({users,plus,jobs,plusPrice:setting('plus_price_label','1.99 USD / شهر'),falConfigured:Boolean(process.env.FAL_KEY),stripeConfigured:Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_PRICE_ID)});});
app.get('/api/admin/users',auth,ownerOnly,(req,res)=>res.json(db.prepare('SELECT id,email,plan,created_at FROM users ORDER BY id DESC LIMIT 500').all()));
app.patch('/api/admin/users/:id/plan',auth,ownerOnly,(req,res)=>{const plan=['free','plus','owner'].includes(req.body.plan)?req.body.plan:null;if(!plan)return res.status(400).json({error:'خطة غير صالحة'});db.prepare('UPDATE users SET plan=? WHERE id=?').run(plan,req.params.id);res.json({ok:true});});
app.post('/api/admin/settings',auth,ownerOnly,(req,res)=>{if(req.body.plusPriceLabel)setSetting('plus_price_label',req.body.plusPriceLabel);res.json({ok:true,plusPrice:setting('plus_price_label')});});

app.use(express.static('web'));
app.get('*',(req,res)=>res.sendFile(path.resolve('web/index.html')));
app.listen(PORT,()=>console.log(`NOVA backend listening on ${PORT}`));
