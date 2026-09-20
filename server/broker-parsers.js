'use strict';

// ============================================================================
// 31TRADES — Native Broker Statement Importer & Parsers
// ----------------------------------------------------------------------------
// Parses statement exports from MetaTrader 5, MetaTrader 4, cTrader,
// Interactive Brokers (IBKR), Tradovate, and NinjaTrader directly into
// normalized BattleX trade objects.
// ============================================================================

const { cleanSymbol, parseDate, detectSession } = require('./broker-sync.js');

// ---------------------------------------------------------------------------
// Format Detection
// ---------------------------------------------------------------------------
function detectBrokerFormat(content) {
    if (!content || typeof content !== 'string') return 'UNKNOWN';
    const s = content.slice(0, 5000);

    if (s.includes('MetaTrader 5') || s.includes('ReportHistory') || (s.includes('Deals') && s.includes('Orders') && s.includes('Positions'))) {
        return 'MT5_REPORT';
    }
    if (s.includes('MetaTrader 4') || (s.includes('Closed Transactions:') && s.includes('Ticket') && s.includes('Open Time'))) {
        return 'MT4_REPORT';
    }
    if (s.includes('cTrader') || (s.includes('Position ID') && s.includes('Opening Direction') && s.includes('Closing Direction'))) {
        return 'CTRADER_CSV';
    }
    if (s.includes('Interactive Brokers') || (s.includes('Trades,Header') && s.includes('Realized P/L'))) {
        return 'IBKR_CSV';
    }
    if (s.includes('NinjaTrader') || (s.includes('Trade number') && s.includes('Market pos.') && s.includes('Entry price'))) {
        return 'NINJATRADER_CSV';
    }
    if (s.includes('Tradovate') || (s.includes('orderId') && s.includes('bought') && s.includes('sold'))) {
        return 'TRADOVATE_CSV';
    }
    if (s.includes('Ticket') && s.includes('Open Time') && s.includes('Close Time') && s.includes('Profit')) {
        return 'GENERIC_MT_CSV';
    }
    return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// 1. MetaTrader 5 HTML / Table Statement Parser
// ---------------------------------------------------------------------------
function parseMt5HtmlReport(htmlContent, accountId) {
    const trades = [];
    if (!htmlContent) return trades;

    // Look for row entries in Deals / Closed Positions tables
    // Typical MT5 table row:
    // <tr><td>2026.09.20 14:30:00</td><td>1049281</td><td>EURUSD</td><td>buy</td><td>in</td><td>0.50</td><td>1.08500</td>...<td>+250.00</td></tr>
    // Or Positions table:
    // <tr><td>2026.09.20 14:30:00</td><td>1049281</td><td>EURUSD</td><td>buy</td><td>0.50</td><td>1.08500</td><td>1.08200</td><td>1.09100</td><td>2026.09.20 15:15:00</td><td>1.08900</td><td>0.00</td><td>-3.50</td><td>200.00</td></tr>

    // Extract all table rows
    const rowMatches = htmlContent.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

    for (const rowHtml of rowMatches) {
        // Strip tags to get cell values
        const cells = [];
        const cellMatches = rowHtml.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
        for (const cell of cellMatches) {
            const val = cell.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
            cells.push(val);
        }

        if (cells.length < 9) continue;

        // Skip table headers
        if (cells.some(c => c.toLowerCase() === 'ticket' || c.toLowerCase() === 'symbol' || c.toLowerCase() === 'position')) {
            continue;
        }

        // Test if this matches a Closed Positions row
        // Pattern: [Open Time, Ticket/Position, Symbol, Type, Volume, Open Price, S/L, T/P, Close Time, Close Price, Commission, Swap, Profit]
        let openTimeStr, ticketStr, symStr, typeStr, volStr, openPriceStr, closeTimeStr, closePriceStr, profitStr;
        let slStr = '', tpStr = '';

        if (cells.length >= 12 && cells[0].match(/^\d{4}[\.\/\-]\d{2}[\.\/\-]\d{2}/)) {
            openTimeStr = cells[0];
            ticketStr = cells[1];
            symStr = cells[2];
            typeStr = cells[3];
            volStr = cells[4];
            openPriceStr = cells[5];
            slStr = cells[6];
            tpStr = cells[7];
            closeTimeStr = cells[8];
            closePriceStr = cells[9];
            profitStr = cells[cells.length - 1];
        } else if (cells.length >= 10 && cells[1].match(/^\d{4}[\.\/\-]\d{2}[\.\/\-]\d{2}/)) {
            ticketStr = cells[0];
            openTimeStr = cells[1];
            typeStr = cells[2];
            volStr = cells[3];
            symStr = cells[4];
            openPriceStr = cells[5];
            closeTimeStr = cells[cells.length - 4];
            closePriceStr = cells[cells.length - 3];
            profitStr = cells[cells.length - 1];
        } else {
            continue;
        }

        const sym = cleanSymbol(symStr);
        if (!sym || sym.length < 2) continue;

        const openPrice = parseFloat(openPriceStr.replace(/,/g, ''));
        const closePrice = parseFloat(closePriceStr.replace(/,/g, ''));
        const profit = parseFloat(profitStr.replace(/[^\d\.\-\+]/g, ''));
        const vol = parseFloat(volStr.replace(/,/g, ''));

        if (isNaN(openPrice) || isNaN(profit)) continue;

        const isLong = typeStr.toLowerCase().includes('buy');
        const openDate = parseDate(openTimeStr);
        const closeDate = parseDate(closeTimeStr);

        trades.push({
            id: 'mt5-imp-' + (ticketStr || trades.length + 1),
            broker_ticket: ticketStr || String(trades.length + 1),
            broker: 'MetaTrader 5',
            source: 'IMPORT',
            account_id: accountId,
            symbol: sym,
            dir: isLong ? 'Long' : 'Short',
            entry: openPrice,
            exit: isNaN(closePrice) ? openPrice : closePrice,
            size: isNaN(vol) ? 1 : vol,
            pnl: profit,
            sl: parseFloat(slStr) || undefined,
            tp: parseFloat(tpStr) || undefined,
            risk: 25,
            setup: 'MT5 Statement Import',
            session: detectSession(openDate),
            opened_at: openDate.toISOString(),
            closed_at: closeDate.toISOString(),
            notes: `Imported from MetaTrader 5 Detailed Report (Ticket #${ticketStr})`,
            tags: ['MT5', 'StatementImport'],
            adherence: 'followed'
        });
    }

    return trades;
}

// ---------------------------------------------------------------------------
// 2. Generic CSV Statement Parser (MT4 / MT5 / cTrader / NinjaTrader)
// ---------------------------------------------------------------------------
function parseCsvStatement(csvContent, accountId) {
    const trades = [];
    if (!csvContent) return trades;

    const lines = csvContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return trades;

    // Find header line
    let headerIdx = -1;
    let headers = [];

    for (let i = 0; i < Math.min(15, lines.length); i++) {
        const lower = lines[i].toLowerCase();
        if ((lower.includes('ticket') || lower.includes('position') || lower.includes('symbol')) &&
            (lower.includes('profit') || lower.includes('p/l') || lower.includes('p&l') || lower.includes('pnl'))) {
            headerIdx = i;
            headers = lines[i].split(',').map(h => h.replace(/["']/g, '').trim().toLowerCase());
            break;
        }
    }

    if (headerIdx === -1) return trades;

    const findCol = (terms) => {
        for (const term of terms) {
            const idx = headers.findIndex(h => h === term || h.includes(term));
            if (idx !== -1) return idx;
        }
        return -1;
    };

    const ticketCol = findCol(['ticket', 'position id', 'position', 'trade number', 'id']);
    const symCol = findCol(['symbol', 'item', 'instrument']);
    const typeCol = findCol(['type', 'direction', 'opening direction', 'action', 'market pos.', 'side']);
    const volCol = findCol(['size', 'volume', 'qty', 'quantity', 'closing quantity', 'lots']);
    const openTimeCol = findCol(['open time', 'entry time', 'time', 'date/time']);
    const openPriceCol = findCol(['open price', 'entry price', 'price', 'entry']);
    const closeTimeCol = findCol(['close time', 'exit time', 'closing time']);
    const closePriceCol = findCol(['close price', 'exit price', 'closing price']);
    const pnlCol = findCol(['profit', 'realized p/l', 'realized net p&l', 'realized p&l', 'p&l', 'p/l', 'pnl', 'net profit']);
    const slCol = findCol(['s/l', 'sl', 'stop loss']);
    const tpCol = findCol(['t/p', 'tp', 'take profit']);

    for (let i = headerIdx + 1; i < lines.length; i++) {
        const cells = lines[i].split(',').map(c => c.replace(/["']/g, '').trim());
        if (cells.length < 4) continue;

        const symStr = symCol !== -1 ? cells[symCol] : null;
        const sym = cleanSymbol(symStr);
        if (!sym || sym.length < 2) continue;

        const ticket = ticketCol !== -1 ? cells[ticketCol] : String(i);
        const openPrice = openPriceCol !== -1 ? parseFloat(cells[openPriceCol]) : NaN;
        const closePrice = closePriceCol !== -1 ? parseFloat(cells[closePriceCol]) : openPrice;
        const pnl = pnlCol !== -1 ? parseFloat(cells[pnlCol].replace(/[^\d\.\-\+]/g, '')) : 0;
        const vol = volCol !== -1 ? parseFloat(cells[volCol]) : 1;

        if (isNaN(openPrice) || isNaN(pnl)) continue;

        const typeStr = typeCol !== -1 ? cells[typeCol].toLowerCase() : 'buy';
        const isLong = typeStr.includes('buy') || typeStr.includes('long');

        const openDate = openTimeCol !== -1 ? parseDate(cells[openTimeCol]) : new Date();
        const closeDate = closeTimeCol !== -1 ? parseDate(cells[closeTimeCol]) : openDate;

        trades.push({
            id: 'csv-imp-' + ticket,
            broker_ticket: ticket,
            broker: 'Statement Import',
            source: 'IMPORT',
            account_id: accountId,
            symbol: sym,
            dir: isLong ? 'Long' : 'Short',
            entry: openPrice,
            exit: isNaN(closePrice) ? openPrice : closePrice,
            size: isNaN(vol) ? 1 : vol,
            pnl,
            sl: slCol !== -1 ? parseFloat(cells[slCol]) || undefined : undefined,
            tp: tpCol !== -1 ? parseFloat(cells[tpCol]) || undefined : undefined,
            risk: 25,
            setup: 'Broker Statement Import',
            session: detectSession(openDate),
            opened_at: openDate.toISOString(),
            closed_at: closeDate.toISOString(),
            notes: `Imported via Statement CSV (Ref #${ticket})`,
            tags: ['StatementImport'],
            adherence: 'followed'
        });
    }

    return trades;
}

// ---------------------------------------------------------------------------
// Auto-detect and Parse Any Broker Statement
// ---------------------------------------------------------------------------
function parseBrokerStatement(content, accountId) {
    if (!content) return { ok: false, error: 'Empty statement file content', trades: [] };

    const format = detectBrokerFormat(content);

    let trades = [];
    if (format === 'MT5_REPORT' || format === 'MT4_REPORT' || content.includes('<tr')) {
        trades = parseMt5HtmlReport(content, accountId);
    }

    // Fallback to CSV parsing if HTML didn't yield rows or format is CSV
    if (!trades.length) {
        trades = parseCsvStatement(content, accountId);
    }

    return {
        ok: true,
        detectedFormat: format,
        count: trades.length,
        trades
    };
}

module.exports = {
    detectBrokerFormat,
    parseMt5HtmlReport,
    parseCsvStatement,
    parseBrokerStatement
};
