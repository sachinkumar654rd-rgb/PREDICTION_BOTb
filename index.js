const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
    getFirestore, doc, setDoc, getDocs,
    collection, getDoc, deleteDoc
} = require('firebase/firestore');

// --- Configuration ---
const BOT_TOKEN = '8750794791:AAF8kgmUbgonYgbghYazDhASizoNX0PFhWE';
const CHANNEL_ID = '-1003233643738'; 
const MAX_HISTORY = 20000;

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

/**
 * Fast API Fetcher (Direct + Proxy Fallback)
 */
async function fetchSafeData() {
    const url = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=20";
    
    // List of multiple proxies for high availability
    const proxies = [
        "", // Direct try
        "https://api.allorigins.win/raw?url=",
        "https://api.codetabs.com/v1/proxy?quest=",
        "https://corsproxy.io/?"
    ];

    for (let p of proxies) {
        try {
            const finalUrl = p ? `${p}${encodeURIComponent(url)}` : url;
            const res = await axios.get(finalUrl, { timeout: 5000 });
            const list = res.data?.data?.list || res.data?.list || res.data;
            if (Array.isArray(list) && list.length > 0) return list;
        } catch (e) { continue; }
    }
    return null;
}

/**
 * Advanced Pattern Match (L9 to L2)
 */
function getAIPrediction(currentSeq, fullHistory) {
    const winHistory = fullHistory.map(h => parseInt(h.number));
    if (winHistory.length < 15) return { r: "BIG", l: "INIT", n: "?" };

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
    // Majority Fallback
    const bigs = currentSeq.filter(n => n >= 5).length;
    return { r: bigs >= 5 ? "BIG" : "SMALL", l: "AUTO", n: "?" };
}

async function loop() {
    try {
        const list = await fetchSafeData();
        if (!list) return;

        // Sync Data to Firebase
        for (let item of list) {
            const id = (item.issueNumber || item.period || item.issue)?.toString();
            const num = parseInt(item.number || item.result);
            if (!id || isNaN(num)) continue;
            await setDoc(doc(db, 'history_v3', id), { issueNumber: id, number: num, timestamp: Date.now() }, { merge: true });
        }

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

        // 1. Force Result Update (Edit)
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actual = latest.number >= 5 ? "BIG" : "SMALL";
            const won = state.prediction === actual;
            const resMsg = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *PREDICTION:* ${state.prediction}\n🎯 *RESULT:* ${actual} (${latest.number})\n🏆 *STATUS:* ${won ? "✅ WIN" : "❌ LOSS"}\n✨ *RISK LEVEL:* L-${state.level || '?'}`;
            
            try {
                // Using bot.telegram directly for faster editing
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, resMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, { done: true }, { merge: true });
                console.log(`Updated Period ${latest.issueNumber}`);
            } catch (e) { console.log("Edit failed - message might be too old or bot not admin"); }
        }

        // 2. Instant New Prediction
        if (state.issueNumber !== nextPeriodId) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = await getAIPrediction(currentSeq, history);
            
            const predText = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *PREDICTION:* **${ai.r}**\n🌪️ *RISK LEVEL:* L-${ai.l}\n🎰 *PREDICTION NO:* ${ai.n}\n🔦 *SCAN HISTORY:* \`${history.length}\` / 20K\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predText, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
                console.log(`New Prediction sent for ${nextPeriodId}`);
            } catch (e) { console.log("Send failed"); }
        }
    } catch (err) {
        console.error("Global Loop Error:", err.message);
    }
}

// Server for Render
const app = express();
app.get('/', (req, res) => res.send('AI Ultra Running'));
app.listen(process.env.PORT || 3000);

// Run loop every 15 seconds for faster updates
setInterval(loop, 15000);
loop();

bot.launch({ dropPendingUpdates: true });
console.log("V4 Ultra Active - 15s Loop");
