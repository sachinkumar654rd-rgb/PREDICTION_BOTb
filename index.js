const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
    getFirestore, doc, setDoc, getDocs,
    collection, getDoc, deleteDoc
} = require('firebase/firestore');

// --- Configuration ---
const BOT_TOKEN = '8750794791:AAGtp1GrVnwZP0EXbMA3lW1lpBVU3whTY98';
const CHANNEL_ID = '-1003233643738'; 
const MAX_HISTORY = 15000;

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

// --- Fast Multi-Source API ---
async function fetchSafeData() {
    // Priority URL
    const url = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=20";
    const proxies = [
        "", // Direct (Fastest)
        "https://api.allorigins.win/raw?url=",
        "https://api.codetabs.com/v1/proxy?quest="
    ];

    for (let p of proxies) {
        try {
            const finalUrl = p ? `${p}${encodeURIComponent(url)}` : url;
            const res = await axios.get(finalUrl, { timeout: 6000 });
            const list = res.data?.data?.list || res.data?.list || res.data;
            if (Array.isArray(list) && list.length > 0) return list;
        } catch (e) {}
    }
    return null;
}

// --- Pattern AI Logic ---
function getAIPrediction(currentSeq, fullHistory) {
    const winHistory = fullHistory.map(h => parseInt(h.number));
    if (winHistory.length < 10) return { r: "BIG", l: "INIT", n: "?" };

    for (let len = 9; len >= 2; len--) {
        const pattern = currentSeq.slice(0, len);
        for (let i = 1; i <= winHistory.length - len - 1; i++) {
            const window = winHistory.slice(i, i + len);
            if (window.every((val, idx) => val === pattern[idx])) {
                const predNum = winHistory[i - 1];
                return { r: predNum >= 5 ? "BIG" : "SMALL", n: predNum, l: len };
            }
        }
    }
    const bigs = currentSeq.slice(0, 5).filter(n => n >= 5).length;
    return { r: bigs >= 3 ? "BIG" : "SMALL", l: "AVG", n: "?" };
}

async function loop() {
    try {
        const list = await fetchSafeData();
        if (!list) return;

        // Step 1: Sync to DB
        for (let item of list) {
            const id = (item.issueNumber || item.period || item.issue)?.toString();
            const num = parseInt(item.number || item.result);
            if (!id || isNaN(num)) continue;
            await setDoc(doc(db, 'history_v3', id), { issueNumber: id, number: num, timestamp: Date.now() }, { merge: true });
        }

        // Step 2: Get History
        const snap = await getDocs(collection(db, 'history_v3'));
        let history = [];
        snap.forEach(d => history.push(d.data()));
        history.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));
        if (history.length === 0) return;

        const latest = history[0];
        const nextPeriodId = (BigInt(latest.issueNumber) + 1n).toString();
        
        const stateRef = doc(db, 'system', 'state_v3');
        const stateSnap = await getDoc(stateRef);
        const state = stateSnap.exists() ? stateSnap.data() : { issueNumber: "0", done: true };

        // Step 3: Result Update (EDIT)
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actualBS = latest.number >= 5 ? "BIG" : "SMALL";
            const isWin = state.prediction === actualBS;
            
            const resultMsg = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *PRED:* ${state.prediction}\n🎯 *RESULT:* ${actualBS} (${latest.number})\n🏆 *STATUS:* ${isWin ? "✅ WIN" : "❌ LOSS"}\n✨ *MATCH:* L-${state.level || '?'}`;
            
            try {
                // Important: Using try-catch for edit specifically
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, resultMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, { done: true }, { merge: true });
                console.log(`✅ Edited Period ${latest.issueNumber}`);
            } catch (e) { 
                console.log("❌ Edit Failed: Admin rights missing or Message ID expired"); 
                // Mark as done anyway to stop infinite retry
                await setDoc(stateRef, { done: true }, { merge: true });
            }
        }

        // Step 4: New Prediction (SEND)
        if (state.issueNumber !== nextPeriodId) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = await getAIPrediction(currentSeq, history);
            
            const predText = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *PREDICTION:* **${ai.r}**\n🌪️ *MATCH:* L-${ai.l}\n🎰 *NUMBER:* ${ai.n}\n⏳ *HISTORY:* \`${history.length}\` / 15K\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predText, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
                console.log(`🚀 New Prediction for ${nextPeriodId}`);
            } catch (e) { console.log("❌ Send Failed"); }
        }

        // Cleanup
        if (history.length > MAX_HISTORY) {
            const oldOnes = history.slice(MAX_HISTORY, MAX_HISTORY + 20);
            for (let o of oldOnes) await deleteDoc(doc(db, 'history_v3', o.issueNumber));
        }

    } catch (err) { console.error("Loop Error:", err.message); }
}

// Fixed History for User check
bot.command('history', async (ctx) => {
    try {
        const snap = await getDocs(collection(db, 'history_v3'));
        let h = []; snap.forEach(d => h.push(d.data()));
        h.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));
        let res = "📊 *Recent Database Records:*\n";
        h.slice(0, 15).forEach(i => { res += `\`${i.issueNumber.slice(-4)}\` -> ${i.number} (${i.number >= 5 ? 'B' : 'S'})\n`; });
        ctx.replyWithMarkdown(res);
    } catch (e) { ctx.reply("Error"); }
});

const app = express();
app.get('/', (req, res) => res.send('Bot V5 Active'));
app.listen(process.env.PORT || 3000);

// Use 12 seconds for ultra-fast checks (Best for 1-minute games)
setInterval(loop, 12000);
loop();

// Ensure bot launches without conflict
bot.launch({ dropPendingUpdates: true })
   .then(() => console.log("Bot Started Successfully"))
   .catch(err => console.error("Launch Failed:", err));
