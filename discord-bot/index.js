'use strict';

// ============================================================================
// BATTLEXJOURNAL — Discord bot (stateless)
// ----------------------------------------------------------------------------
// Responsibilities:
//   · guildMemberAdd  → single branded welcome embed + Get Started / Verify
//   · /verify /start /profile slash commands + welcome button handlers
//   · re-verification & role re-assignment on rejoin (never removes roles)
//
// Reliability contract:
//   · One failed event must never crash the process — every handler wrapped.
//   · Duplicate guildMemberAdd (rejoin / cache replay) → at most one welcome
//     per member join; duplicates are tolerated gracefully (Discord dedupes
//     per join; we also guard against reacting to bots).
//   · Missing channels / roles / permissions degrade to logged warnings.
//   · Supabase failures → ephemeral error message to the user, never a crash.
// ============================================================================

const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');
const config = require('./config.js');
const branding = require('./branding.js');
const store = require('./store.js');
const { startHealthServer } = require('./health.js');

// ---------------------------------------------------------------------------
// Logging (secrets never logged)
// ---------------------------------------------------------------------------
function log(scope, msg) { console.log('[bot] ' + scope + ': ' + msg); }
function errBrief(e) { return (e && e.message) || String(e); }

// ---------------------------------------------------------------------------
// Discord client — minimal privileged intents
// ---------------------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers   // privileged — enable in the Dev Portal
    ],
    partials: [Partials.GuildMember]     // guildMemberAdd can arrive as a partial
});

// ---------------------------------------------------------------------------
// Safe wrappers
// ---------------------------------------------------------------------------
async function safeReply(interaction, payload) {
    try {
        if (interaction.deferred) return await interaction.editReply(payload);
        if (interaction.replied) return await interaction.followUp(payload);
        return await interaction.reply({ ...payload, ephemeral: true });
    } catch (e) {
        log('reply', 'failed: ' + errBrief(e));
    }
}

async function safeEphemeral(interaction, embed) {
    return safeReply(interaction, { embeds: [embed], ephemeral: true });
}

// ---------------------------------------------------------------------------
// Role assignment (best effort — never fails verification)
// ---------------------------------------------------------------------------
async function grantVerifiedRole(member) {
    if (!config.verifiedRoleId) {
        log('role', 'VERIFIED_TRADER_ROLE_ID not set — skipping');
        return { ok: false, attempted: false };
    }
    try {
        const guild = client.guilds.cache.get(config.guildId) || (member && member.guild);
        if (!guild) { log('role', 'guild not found'); return { ok: false, attempted: true }; }

        const me = guild.members.me;
        if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
            log('role', 'bot lacks Manage Roles permission');
            return { ok: false, attempted: true };
        }
        const role = guild.roles.cache.get(config.verifiedRoleId);
        if (!role) { log('role', 'role ' + config.verifiedRoleId + ' not found in cache'); return { ok: false, attempted: true }; }
        if (me.roles.highest && role.position >= me.roles.highest.position) {
            log('role', 'role hierarchy: Verified Trader is above the bot role');
            return { ok: false, attempted: true };
        }
        if (member.roles.cache.has(role.id)) return { ok: true, attempted: true, already: true };

        await member.roles.add(role, 'BattleX verification complete');
        log('role', 'granted Verified Trader to ' + member.id);
        return { ok: true, attempted: true };
    } catch (e) {
        log('role', 'assignment failed: ' + errBrief(e) + ' — verification stays successful');
        return { ok: false, attempted: true };
    }
}

// ---------------------------------------------------------------------------
// Welcome flow
// ---------------------------------------------------------------------------
async function sendWelcome(member) {
    try {
        if (!config.welcomeChannelId) { log('welcome', 'WELCOME_CHANNEL_ID not set — skipping'); return; }
        const guild = member.guild;
        const channel = guild.channels.cache.get(config.welcomeChannelId)
            || (config.welcomeChannelId === 'welcome' ? guild.channels.cache.find(c => c.name === 'welcome' && c.isTextBased()) : null);
        if (!channel) { log('welcome', 'welcome channel not found — skipping'); return; }

        const embed = branding.welcomeEmbed('<@' + member.id + '>');
        const row = new ActionRowBuilder().addComponents(
            ...branding.WELCOME_BUTTONS.map(b => new ButtonBuilder()
                .setCustomId(b.customId)
                .setLabel(b.label)
                .setStyle(b.style)
                .setEmoji(b.emoji))
        );

        await channel.send({ embeds: [embed], components: [row] });
        log('welcome', 'greeted ' + member.id + ' in #' + (channel.name || config.welcomeChannelId));
    } catch (e) {
        log('welcome', 'failed: ' + errBrief(e) + ' — continuing');
    }
}

client.on('guildMemberAdd', async (member) => {
    try {
        if (!member || member.user?.bot) return;              // ignore bots
        await sendWelcome(member);
        // Returning verified member (rejoin): silently re-grant the role.
        try {
            if (await store.isVerified(member.id)) await grantVerifiedRole(member);
        } catch (e) { log('rejoin', 'verified-check failed: ' + errBrief(e)); }
    } catch (e) {
        log('guildMemberAdd', 'error: ' + errBrief(e) + ' — continuing');
    }
});

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isButton()) return void await onButton(interaction);
        if (interaction.isChatInputCommand()) return void await onCommand(interaction);
    } catch (e) {
        log('interaction', 'error: ' + errBrief(e));
        try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ embeds: [branding.errorEmbed()], ephemeral: true }); } catch (e2) {}
    }
});

async function onButton(interaction) {
    if (interaction.customId === 'bxj:get_started') {
        return safeEphemeral(interaction, EmbedBuilder.from(branding.getStartedEmbed()));
    }
    if (interaction.customId === 'bxj:verify') {
        return safeReply(interaction, { embeds: [verifyEmbed()], components: [verifyRow()] });
    }
}

function verifyEmbed() {
    return EmbedBuilder.from({
        color: branding.BRAND.color,
        title: '🔐  Verify your BattleX account',
        description: [
            'Verification links this Discord account to your BattleXJournal account.',
            '',
            '**How it works**',
            '1 · Open the button below and sign in to BattleXJournal.',
            '2 · Approve Discord on the consent screen.',
            '3 · Done — identity linked, role granted, `/profile` unlocked.',
            '',
            '_You never type your Trader ID. Signing in IS the proof._'
        ].join('\n'),
        footer: { text: branding.BRAND.footer }
    });
}

function verifyRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Verify on BattleXJournal')
            .setStyle(ButtonStyle.Link)
            .setURL(config.battlexUrl + '/settings.html?verify=discord')
    );
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
async function onCommand(interaction) {
    switch (interaction.commandName) {
        case 'verify': {
            await interaction.deferReply({ ephemeral: true });
            try {
                const profile = await store.getVerifiedProfile(interaction.user.id);
                if (profile) {
                    const e = EmbedBuilder.from(branding.profileEmbed({ ...profile, discordUsername: interaction.user.id }));
                    e.setDescription('✅ Already verified — no action needed. Your Discord and BattleX accounts are linked.');
                    return safeReply(interaction, { embeds: [e] });
                }
            } catch (e) {
                log('verify', 'store lookup failed: ' + errBrief(e));
                return safeEphemeral(interaction, EmbedBuilder.from(branding.errorEmbed('The verification service is unreachable right now. Please try again shortly.')));
            }
            return safeReply(interaction, { embeds: [verifyEmbed()], components: [verifyRow()] });
        }
        case 'start':
            return safeEphemeral(interaction, EmbedBuilder.from(branding.startEmbed()));
        case 'profile': {
            await interaction.deferReply({ ephemeral: true });
            try {
                const profile = await store.getVerifiedProfile(interaction.user.id);
                if (!profile) return safeEphemeral(interaction, EmbedBuilder.from(branding.notVerifiedEmbed(config.battlexUrl)));
                return safeReply(interaction, { embeds: [EmbedBuilder.from(branding.profileEmbed({ ...profile, discordUsername: interaction.user.id }))] });
            } catch (e) {
                log('profile', 'store lookup failed: ' + errBrief(e));
                return safeEphemeral(interaction, EmbedBuilder.from(branding.errorEmbed('The profile service is unreachable right now. Please try again shortly.')));
            }
        }
        default:
            return;
    }
}

// ---------------------------------------------------------------------------
// Command registration (guild-scoped when DISCORD_GUILD_ID is set — instant)
// ---------------------------------------------------------------------------
async function registerCommands(rest) {
    const body = [
        { name: 'verify', description: 'Link your BattleXJournal account to Discord' },
        { name: 'start', description: 'How BattleXJournal + Discord works' },
        { name: 'profile', description: 'Show your BattleX trader profile (requires verification)' }
    ];
    try {
        const route = config.guildId
            ? Routes.applicationGuildCommands(config.clientId, config.guildId)
            : Routes.applicationCommands(config.clientId);
        await rest.put(route, { body });
        log('commands', 'registered ' + body.length + ' commands' + (config.guildId ? ' (guild-scoped)' : ' (global)'));
    } catch (e) {
        log('commands', 'registration failed: ' + errBrief(e) + ' — will retry on next start');
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let healthState = { discord: 'connecting', readyAt: null };

client.once('clientReady', async (c) => {
    log('discord', 'connected as ' + c.user.tag);
    healthState = { discord: 'ready', readyAt: new Date().toISOString() };
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    await registerCommands(rest);
});

client.on('shardDisconnect', (event, id) => log('shard', 'disconnect (shard ' + id + ') — discord.js will auto-reconnect'));
client.on('shardReconnecting', (id) => log('shard', 'reconnecting (shard ' + id + ')'));
client.on('shardResume', (id, replayed) => log('shard', 'resumed (shard ' + id + ', ' + replayed + ' events replayed)'));
client.on('error', (e) => log('client', 'error: ' + errBrief(e)));
client.on('warn', (w) => log('client', 'warn: ' + w));

process.on('unhandledRejection', (e) => log('process', 'unhandled rejection: ' + errBrief(e)));
process.on('uncaughtException', (e) => {
    log('process', 'uncaught exception: ' + errBrief(e) + ' — keeping the process alive');
});

client.login(config.discordToken).catch(e => {
    log('login', 'FAILED: ' + errBrief(e));
    console.error('[bot] Check DISCORD_TOKEN. Not exiting so the platform health check still answers; restart after fixing the env var.');
});

startHealthServer(config.port, () => healthState);
