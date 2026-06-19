import fs from 'fs';
import AdmZip from 'adm-zip';

export function parseWhatsappUpload(file) {
  try {
    const name = String(file.originalname || '').toLowerCase();
    let text = '';
    if (name.endsWith('.zip')) {
      const zip = new AdmZip(file.path);
      for (const entry of zip.getEntries()) {
        if (!entry.isDirectory && /\.txt$/i.test(entry.entryName)) {
          text += '\n' + entry.getData().toString('utf8');
        }
      }
    } else {
      text = fs.readFileSync(file.path, 'utf8');
    }
    const actions = extractActions(text);
    const stockRequests = extractStockRequests(text);
    const photoCount = (text.match(/\b(image omitted|photo|\.jpg|\.png|<attached:)/gi) || []).length;
    return {
      ok: true,
      source: file.originalname,
      messageCount: text.split(/\r?\n/).filter(Boolean).length,
      photoCount,
      actions,
      stockRequests,
      summary: summarize(actions, stockRequests, photoCount),
      parsedAt: new Date().toISOString()
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function extractActions(text) {
  const actions = [];
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/sell.?out|sold out|empty|finished|no more/.test(lower)) {
      actions.push(makeAction('Sell-out', line, 'Check timing and next-week repeat risk'));
    } else if (/stock|need|order|milk|container|coffee shot|cups|bags|boxes|tray/.test(lower)) {
      actions.push(makeAction('Stock', line, 'Add to weekly stock-use estimate and two-trip delivery plan'));
    } else if (/clean|display|cabinet|photo|training|staff/.test(lower)) {
      actions.push(makeAction('Ops', line, 'Manager follow-up / training evidence'));
    }
  }
  return actions.slice(0, 80);
}

function extractStockRequests(text) {
  const words = ['milk', 'coffee', 'cups', 'bags', 'boxes', 'gloves', 'napkins', 'trays', 'balls', 'rings'];
  const counts = {};
  for (const word of words) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    counts[word] = (text.match(re) || []).length;
  }
  return Object.entries(counts).filter(([, count]) => count).map(([item, count]) => ({ item, count }));
}

function makeAction(type, text, recommendation) {
  return { id: `wa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, type, text, recommendation, status: 'Open' };
}

function summarize(actions, stockRequests, photoCount) {
  return `${actions.length} operational messages detected; ${stockRequests.length} stock terms; ${photoCount} possible photos/attachments. Use this to build weekly stock usage and sell-out timing.`;
}
