const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
    getFirestore, doc, setDoc, getDocs,
    collection, getDoc, query, orderBy, limit, writeBatch
} = require('firebase/firestore');

// --- 1. Configuration ---
const BOT_TOKEN = '8750794791:AAGtp1GrVnwZP0EXbMA3lW1lpBVU3whTY98';
const CHANNEL_ID = '-1003233643738'; 
const RENDER_EXTERNAL_URL = "https://prediction-botb.onrender.com"; 

const firebaseConfig = {
  apiKey: "AIzaSyDwc1YILR9mGbwVliAU6uBBPQCqEVTUS7o",
  authDomain: "my-prediction-bot.firebaseapp.com",
  projectId: "my-prediction-bot",
  storageBucket: "my-prediction-bot.firebasestorage.app",
  messagingSenderId: "455075620861",
  appId: "1:455075620861:web:8a414f39fac3350627db94"
};

const firebaseApp = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

// --- 2. Database Cleanup (To keep it fast) ---
async function cleanupDatabase() {
    try {
        const collRef = collection(db, 'history_v3');
        const snap = await getDocs(collRef);
        if (snap.size > 20000) {
            console.log("Cleaning up old data...");
            const q = query(collRef, orderBy('issueNumber', 'asc'), limit(5000));
            const oldDocs = await getDocs(q);
            const batch = writeBatch(db);
            oldDocs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log("Cleanup Done.");
        }
    } catch (e) { console.log("Cleanup Error:", e.message); }
}

// --- 3. Optimized API Fetcher ---
async function fetchSafeData() {
    const url = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=20";
    try {
        const res = await axios.get(url, { timeout: 4000 });
        return res.data?.data?.list || res.data?.list || null;
    } catch (e) {
        try {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
            const res = await axios.get(proxyUrl, { timeout: 6000 });
            return res.data?.data?.list || res.data?.list || null;
        } catch (err) { return null; }
    }
}

// --- 4. Pattern AI Logic ---
function getAIPrediction(currentSeq, fullHistory) {
    const winHistory = fullHistory.map(h => parseInt(h.number));
    for (let len = 9; len >= 2; len--) {
        const pattern = currentSeq.slice(0, len);
        for (let i = 1; i <= winHistory.length - len - 1; i++) {
            const window = winHistory.slice(i, i + len);
            if (window.every((val, idx) => val === pattern[idx])) {
                const predNum = winHistory[i - 1];
                return { r: predNum >= 5 ? "BIG" : "SMALL", l: len, n: predNum };
            }
        }
    }
    const last5 = currentSeq.slice(0, 5);
    const bigs = last5.filter(n => n >= 5).length;
    return { r: bigs >= 3 ? "BIG" : "SMALL", l: "AUTO", n: "?" };
}

// --- 5. Main Execution Loop ---
async function loop() {
    try {
        const list = await fetchSafeData();
        if (!list || !Array.isArray(list)) return;

        // Sync Data to Firebase
        for (let item of list) {
            const id = (item.issueNumber || item.period).toString();
            const num = parseInt(item.number || item.result);
            if (id && !isNaN(num)) {
                await setDoc(doc(db, 'history_v3', id), { issueNumber: id, number: num }, { merge: true });
            }
        }

        const snap = await getDocs(collection(db, 'history_v3'));
        let history = [];
        snap.forEach(d => history.push(d.data()));
        
        // Accurate Sorting for BigInt Periods
        history.sort((a, b) => (BigInt(b.issueNumber) > BigInt(a.issueNumber) ? 1 : -1));
        
        if (history.length === 0) return;

        const latest = history[0];
        const nextPeriodId = (BigInt(latest.issueNumber) + 1n).toString();
        
        const stateRef = doc(db, 'system', 'state_v3');
        const stateSnap = await getDoc(stateRef);
        let state = stateSnap.exists() ? stateSnap.data() : { issueNumber: "0", done: true };

        // STEP A: RESULT UPDATE (EDIT MESSAGE)
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actual = latest.number >= 5 ? "BIG" : "SMALL";
            const isWin = state.prediction === actual;
            const resText = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *PRED:* ${state.prediction}\n🎯 *RESULT:* ${actual} (${latest.number})\n🏆 *STATUS:* ${isWin ? "✅ WIN" : "❌ LOSS"}\n✨ *MATCH:* L-${state.level}\n━━━━━━━━━━━━━━`;
            
            try {
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, resText, { parse_mode: 'Markdown' });
                console.log("✅ Edit Success");
            } catch (e) {
                console.log("⚠️ Edit Skip (Old or Deleted)");
            }
            await setDoc(stateRef, { done: true }, { merge: true });
        }

        // STEP B: SEND NEW PREDICTION
        if (state.issueNumber !== nextPeriodId && (state.done || state.issueNumber === latest.issueNumber)) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = getAIPrediction(currentSeq, history);
            
            const predMsg = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *PREDICTION:* **${ai.r}**\n🌪️ *MATCH:* L-${ai.l}\n🎰 *NUMBER:* ${ai.n}\n⏳ *DB SIZE:* \`${history.length}\` / 20K\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
                console.log("🚀 New Prediction Sent");
            } catch (e) { console.log("❌ Send Failed:", e.message); }
        }

    } catch (err) { console.log("Loop Error:", err.message); }
}

// --- 6. Server & Keep-Alive ---
const app = express();
app.get('/', (req, res) => res.send('Bot is Running 24/7'));
app.listen(process.env.PORT || 3000, () => {
    console.log("Web server active");
});

// Pinger: Har 2 minute me khud ko ping karega taaki Render na soye
setInterval(() => {
    axios.get(RENDER_EXTERNAL_URL).catch(() => {});
}, 120000);

// Loops
setInterval(loop, 10000); // Har 10 second me check
setInterval(cleanupDatabase, 3600000); // Har 1 ghante me DB check karein
loop();

bot.launch({ dropPendingUpdates: true });
console.log("Bot Started Successfully");
