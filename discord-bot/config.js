'use strict';

// ============================================================================
// BATTLEXJOURNAL — Bot configuration (environment only; nothing hardcoded)
// ----------------------------------------------------------------------------
// Required:  DISCORD_TOKEN, DISCORD_CLIENT_ID, SUPABASE_URL,
//            SUPABASE_SERVICE_ROLE_KEY
// Optional:  DISCORD_GUILD_ID, WELCOME_CHANNEL_ID, VERIFIED_TRADER_ROLE_ID,
//            BATTLEXJOURNAL_URL, PORT
// ============================================================================

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter(k => !process.env[k] || !String(process.env[k]).trim());

if (missing.length) {
    // Fail loudly but do NOT print values — names only.
    console.error('[config] Missing required environment variables: ' + missing.join(', '));
    process.exit(1);
}

function str(k, d) { const v = process.env[k]; return v && String(v).trim() ? String(v).trim() : d; }

module.exports = {
    discordToken: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID', ''),
    welcomeChannelId: str('WELCOME_CHANNEL_ID', ''),
    verifiedRoleId: str('VERIFIED_TRADER_ROLE_ID', ''),
    battlexUrl: str('BATTLEXJOURNAL_URL', 'https://battlexjournal.com').replace(/\/+$/, ''),
    supabaseUrl: str('SUPABASE_URL').replace(/\/+$/, ''),
    supabaseKey: str('SUPABASE_SERVICE_ROLE_KEY'),
    port: parseInt(process.env.PORT || '8080', 10)
};
