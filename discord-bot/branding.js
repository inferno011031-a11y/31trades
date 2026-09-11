'use strict';

// ============================================================================
// BATTLEXJOURNAL — BattleX brand kit for Discord embeds
// ----------------------------------------------------------------------------
// Dark, premium, trading-oriented. Obsidian canvas, cyan edge, mono accents.
// Matches the web app's MASTER-UI design language.
// ============================================================================

const BRAND = {
    color: 0x22D3EE,            // BattleX cyan edge
    colorOk: 0x34D399,          // verified / success
    colorWarn: 0xFBBF24,        // caution
    colorErr: 0xF87171,         // failure
    footer: 'BATTLEXJOURNAL · Every request. Every seat. Every signal.',
    thumbnail: process.env.BATTLEXJOURNAL_URL
        ? process.env.BATTLEXJOURNAL_URL.replace(/\/+$/, '') + '/logo.png'
        : undefined
};

// Welcome embed — concise and premium, exactly per spec.
function welcomeEmbed(username) {
    return {
        color: BRAND.color,
        title: '⚔️  BATTLEXJOURNAL',
        description: [
            `**Welcome to BattleXJournal, ${username}**`,
            '',
            'Track your trades.',
            'Study your decisions.',
            'Build your edge.',
            '',
            'Connect your BattleXJournal account to unlock the full trader experience.'
        ].join('\n'),
        fields: [
            { name: 'GET STARTED', value: '`/start` — how the journal + Discord fit together', inline: true },
            { name: 'VERIFY', value: '`/verify` — link your BattleX account', inline: true }
        ],
        footer: { text: BRAND.footer }
    };
}

const WELCOME_BUTTONS = [
    {
        label: 'Get Started',
        emoji: '🚀',
        style: 1,               // Primary (cyan-ish in dark theme)
        customId: 'bxj:get_started'
    },
    {
        label: 'Verify BattleX',
        emoji: '🔐',
        style: 3,               // Success (green)
        customId: 'bxj:verify'
    }
];

function getStartedEmbed() {
    return {
        color: BRAND.color,
        title: '🚀  Getting Started',
        description: [
            '**1 · Create your account**',
            `Sign up at ${process.env.BATTLEXJOURNAL_URL || 'https://battlexjournal.com'} — takes under a minute.`,
            '',
            '**2 · Verify BattleX**',
            'Click **🔐 Verify BattleX** (or run `/verify`), then sign in on the web page that opens.',
            'Your Discord ID is linked to your BattleX account automatically — nothing to type, nothing to fake.',
            '',
            '**3 · Unlock the Verified Trader role**',
            'Once verified you get the Verified Trader role and your `/profile` comes alive.'
        ].join('\n'),
        footer: { text: BRAND.footer }
    };
}

function startEmbed() {
    return {
        color: BRAND.color,
        title: '⚔️  What is BattleXJournal?',
        description: [
            'A next-generation trading journal with real-time risk guards,',
            'a 6-dimension discipline engine and an AI mentor that studies',
            'how you trade — not just what you traded.',
            '',
            '**Discord ↔ BattleX**',
            'Verify once and this server knows you are a real BattleX trader.',
            'Your identity, your plan, your edge — linked, not claimed.'
        ].join('\n'),
        fields: [
            { name: 'COMMANDS', value: '`/verify` · `/start` · `/profile`', inline: false }
        ],
        footer: { text: BRAND.footer }
    };
}

function notVerifiedEmbed(battlexUrl) {
    return {
        color: BRAND.colorWarn,
        title: '🔐  Not verified yet',
        description: [
            'Your Discord account is not linked to a BattleXJournal account.',
            '',
            `Click **🔐 Verify BattleX** or run \`/verify\`, then sign in at ${battlexUrl}.`,
            'Verification is automatic — your BattleX identity is claimed by signing in, never by typing IDs.'
        ].join('\n'),
        footer: { text: BRAND.footer }
    };
}

function profileEmbed({ displayName, battlexId, tier, aiUsed, aiLimit, expiresAt, discordUsername }) {
    const fields = [
        { name: 'TRADER', value: displayName || 'Trader', inline: true },
        { name: 'BATTLEX ID', value: '`' + battlexId + '`', inline: true },
        { name: 'PLAN', value: tier, inline: true }
    ];
    if (aiUsed !== undefined && aiLimit !== undefined) {
        fields.push({ name: 'AI QUOTA', value: `${aiUsed} / ${aiLimit}${(aiLimit || 0) >= 50 ? ' lifetime' : ' this month'}`, inline: true });
    }
    if (expiresAt) {
        fields.push({ name: 'ACCESS EXPIRES', value: expiresAt, inline: true });
    }
    return {
        color: BRAND.colorOk,
        title: '🪪  BattleX Trader Profile',
        description: `Verified link for <@${discordUsername}> — identity confirmed via BattleX sign-in.`,
        fields,
        footer: { text: BRAND.footer }
    };
}

function errorEmbed(message) {
    return {
        color: BRAND.colorErr,
        title: '⚠️  Something went wrong',
        description: message || 'An unexpected error occurred. Please try again in a moment.',
        footer: { text: BRAND.footer }
    };
}

module.exports = { BRAND, welcomeEmbed, WELCOME_BUTTONS, getStartedEmbed, startEmbed, notVerifiedEmbed, profileEmbed, errorEmbed };
