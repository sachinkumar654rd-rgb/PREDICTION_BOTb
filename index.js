const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
    getFirestore, doc, setDoc, getDocs,
    collection, getDoc, query, orderBy, limit, writeBatch
} = require('firebase/firestore');

// --- 1. Configuration (Naya Token Yahan Daalein) ---
const BOT_TOKEN = '8750794791:AAGJCVJ5xPt2NlQmpM6SeYf1W6-PMYWbIAQ';
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

let isLoopRunning = false;

// --- 2. Database Cleanup (Har 1 Ghante Me) ---
async function cleanupDatabase() {
    try {
        const collRef = collection(db, 'history_v3');
        const snap = await getDocs(collRef);
        if (snap.size > 20000) {
            const q = query(collRef, orderBy('issueNumber', 'asc'), limit(5000));
            const oldDocs = await getDocs(q);
            const batch = writeBatch(db);
            oldDocs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log("🧹 Cleanup Done: 5000 records deleted");
        }
    } catch (e) { console.log("Cleanup Error:", e.message); }
}

// --- 3. Fast API Fetcher ---
async function fetchSafeData() {
    const url = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=10";
    try {
        const res = await axios.get(url, { timeout: 5000 });
        return res.data?.data?.list || res.data?.list || null;
    } catch (e) {
        try {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
            const res = await axios.get(proxyUrl, { timeout: 7000 });
            return res.data?.data?.list || res.data?.list || null;
        } catch (err) { return null; }
    }
}

// --- 4. Prediction Logic ---
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

// --- 5. Main Loop (With 409 Protection) ---
async function loop() {
    if (isLoopRunning) return;
    isLoopRunning = true;

    try {
        const list = await fetchSafeData();
        if (!list) { isLoopRunning = false; return; }

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
        history.sort((a, b) => (BigInt(b.issueNumber) > BigInt(a.issueNumber) ? 1 : -1));
        
        if (history.length === 0) { isLoopRunning = false; return; }

        const latest = history[0];
        const nextPeriodId = (BigInt(latest.issueNumber) + 1n).toString();
        
        const stateRef = doc(db, 'system', 'state_v3');
        const stateSnap = await getDoc(stateRef);
        let state = stateSnap.exists() ? stateSnap.data() : { issueNumber: "0", done: true };

        // RESULT UPDATE
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actual = latest.number >= 5 ? "BIG" : "SMALL";
            const isWin = state.prediction === actual;
            const resText = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *PRED:* ${state.prediction}\n🎯 *RESULT:* ${actual} (${latest.number})\n🏆 *STATUS:* ${isWin ? "✅ WIN" : "❌ LOSS"}\n✨ *MATCH:* L-${state.level}\n━━━━━━━━━━━━━━`;
            
            try {
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, resText, { parse_mode: 'Markdown' });
            } catch (e) { console.log("Edit Skip"); }
            await setDoc(stateRef, { done: true }, { merge: true });
        }

        // NEW PREDICTION
        if (state.issueNumber !== nextPeriodId && (state.done || state.issueNumber === latest.issueNumber)) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = getAIPrediction(currentSeq, history);
            
            const predMsg = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *PREDICTION:* **${ai.r}**\n🌪️ *MATCH:* L-${ai.l}\n🎰 *NUMBER:* ${ai.n}\n⏳ *DB:* \`${history.length}\` / 20K\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
            } catch (e) { console.log("Send Error:", e.message); }
        }

    } catch (err) { console.log("Loop Error:", err.message); }
    isLoopRunning = false;
}

// --- 6. Express Server for 24/7 ---
const app = express();
app.get('/', (req, res) => res.send('Bot Active 24/7'));
app.listen(process.env.PORT || 3000);

// Keep-Alive: 2 minute pinger
setInterval(() => {
    axios.get(RENDER_EXTERNAL_URL).catch(() => {});
}, 120000);

// Execution
setInterval(loop, 12000); 
setInterval(cleanupDatabase, 3600000);
loop();

// Error Handling to prevent crash
bot.catch((err) => console.error("Bot Error:", err));
bot.launch({ dropPendingUpdates: true }).then(() => console.log("🚀 Bot Started"));
