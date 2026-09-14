'use strict';

// ============================================================================
// 31TRADES — Email service powered by Resend
// ----------------------------------------------------------------------------
// Loads RESEND_API_KEY from .env (or environment).
// Default sender: 'BattleX Journal <onboarding@resend.dev>' (or RESEND_FROM in .env).
// ============================================================================

const { Resend } = require('resend');

let _client = null;

function getClient() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return null;
    if (!_client || _client.key !== apiKey) {
        _client = new Resend(apiKey);
        _client.key = apiKey;
    }
    return _client;
}

/**
 * Send an email via Resend
 * @param {Object} options
 * @param {string} [options.from]
 * @param {string|string[]} options.to
 * @param {string} options.subject
 * @param {string} [options.html]
 * @param {string} [options.text]
 */
async function sendEmail({
    from = process.env.RESEND_FROM || 'BattleX Journal <onboarding@resend.dev>',
    to,
    subject,
    html,
    text
}) {
    const client = getClient();
    if (!client) {
        console.warn('[Resend] Warning: RESEND_API_KEY is not set. Email was not sent.');
        return { success: false, error: 'RESEND_API_KEY missing' };
    }

    const recipients = Array.isArray(to) ? to : [to];

    try {
        const { data, error } = await client.emails.send({
            from,
            to: recipients,
            subject,
            html,
            text
        });

        if (error) {
            console.error('[Resend Error]:', error);
            return { success: false, error };
        }

        console.log('[Resend Success]: Email sent to', recipients.join(', '), 'ID:', data?.id);
        return { success: true, data };
    } catch (err) {
        console.error('[Resend Exception]:', err.message || err);
        return { success: false, error: err.message || err };
    }
}

/**
 * Send welcome email to a new user
 */
async function sendWelcomeEmail({ email, name }) {
    const userName = name || (email ? email.split('@')[0] : 'Trader');
    return sendEmail({
        to: email,
        subject: '⚡ Welcome to BattleX Journal – Elevate Your Trading Edge',
        html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0c0d0e; color: #d1d5db; margin: 0; padding: 40px 20px; }
            .container { max-width: 560px; margin: 0 auto; background: #131517; border: 1px solid #22262a; border-radius: 12px; padding: 32px; }
            .logo { font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; margin-bottom: 24px; }
            .logo span { color: #3b82f6; }
            h1 { font-size: 22px; font-weight: 600; color: #ffffff; margin: 0 0 16px 0; }
            p { font-size: 14px; line-height: 1.6; color: #9ca3af; margin: 0 0 16px 0; }
            .card { background: #1a1d20; border: 1px solid #272b30; border-radius: 8px; padding: 16px; margin: 20px 0; }
            .card-item { display: flex; align-items: center; font-size: 13px; color: #e5e7eb; margin-bottom: 10px; }
            .card-item:last-child { margin-bottom: 0; }
            .badge { background: rgba(37,99,235,0.15); color: #60a5fa; border: 1px solid rgba(37,99,235,0.3); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-right: 10px; display: inline-block; }
            .btn { display: inline-block; background-color: #2563eb; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-top: 16px; }
            .footer { margin-top: 32px; border-top: 1px solid #22262a; padding-top: 20px; font-size: 12px; color: #6b7280; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">BATTLEX<span>JOURNAL</span></div>
            <h1>Welcome aboard, ${userName}! 📈</h1>
            <p>You’re now equipped with the institutional trading terminal designed for disciplined execution, precision backtesting, and actionable metrics.</p>
            
            <div class="card">
              <div class="card-item"><span class="badge">EXECUTION</span> Drag & Drop Visual SL/TP order lines directly on TradingView charts.</div>
              <div class="card-item"><span class="badge">DISCIPLINE</span> Automated Risk Management & Rule Engine protection.</div>
              <div class="card-item"><span class="badge">ANALYTICS</span> Deep-dive journal analytics, win-rates, and behavioral tracking.</div>
            </div>

            <p>Ready to log your first trade or backtest your strategy?</p>
            <a href="http://localhost:8080/journal.html" class="btn">Launch BattleX Terminal →</a>

            <div class="footer">
              <p>Trade with rules, execute with zero hesitation.<br>© BattleX Journal. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
        `
    });
}

module.exports = {
    sendEmail,
    sendWelcomeEmail
};