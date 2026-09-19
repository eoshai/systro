require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Options,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ActivityType,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// ---------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OCR_API_KEY = process.env.OCR_API_KEY;
const VERIFICATION_CHANNEL_ID = process.env.VERIFICATION_CHANNEL_ID;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const HONEYPOT_CHANNEL_ID = process.env.HONEYPOT_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;

// IDs do Chat da Staff e Cargo da Equipe de Suporte
const STAFF_CHANNEL_ID = process.env.STAFF_CHANNEL_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

// Canal onde o usuário reivindica os cargos após a aprovação pública (/aprovar visivel:true)
const ROLES_CHANNEL_ID = process.env.ROLES_CHANNEL_ID;
const ROLES_BUTTON_URL =
  process.env.ROLES_BUTTON_URL;

// Configurações adicionais
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // Limite de 5MB por imagem
const RESULT_CLEANUP_DELAY_MS = 7500;

// Rate limit de tentativas de verificação (evita spam/abuso do OCR)
const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos

// Após quantas recusas seguidas o bot sugere abrir um ticket com a staff
const MAX_CONSECUTIVE_FAILURES = 3;

if (!DISCORD_TOKEN) {
  console.error('[ERRO FATAL] DISCORD_TOKEN não definido no .env. Encerrando bot.');
  process.exit(1);
}

const CHANNEL_NAME_VARIANTS = (process.env.CHANNEL_NAME_VARIANTS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const CONFIRMATION_WORDS = [
  'inscrito',
  'inscrita',
  'nscrito',
  'nscrita',
  'suscrito',
  'suscrita',
  'suscripto',
  'subscribed',
];

const NOT_SUBSCRIBED_WORDS = [
  'se inscrever',
  'inscrever-se',
  'inscreva-se',
  'suscribirse',
  'subscribe',
];

// ---------------------------------------------------------------------
// Utilidades de texto e agendamento
// ---------------------------------------------------------------------

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9@_\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(normalizedText, list) {
  return list.some((term) => normalizedText.includes(normalize(term)));
}

function hasConfirmationWord(normalizedText) {
  for (const word of CONFIRMATION_WORDS) {
    const regex = new RegExp(`(.{0,20})\\b${word}\\b`, 'g');
    let match;
    while ((match = regex.exec(normalizedText)) !== null) {
      const context = match[1];
      const precededByNumber = /(\d[\d.,]*\s*(mil|milhoes|milhões|mi|k|m)?\s*)$/.test(context);
      if (!precededByNumber) return true;
    }
  }
  return false;
}

function scheduleMessageCleanup(userMessage, botResponse) {
  setTimeout(async () => {
    await userMessage.delete().catch(() => {});
    await botResponse.delete().catch(() => {});
  }, RESULT_CLEANUP_DELAY_MS);
}

// ---------------------------------------------------------------------
// Deduplicação de eventos
// Proteção contra o Discord Gateway despachando o mesmo evento mais de
// uma vez (ex.: após um resume de conexão). Isto NÃO protege contra duas
// instâncias/processos do bot rodando ao mesmo tempo com o mesmo token —
// isso precisa ser resolvido garantindo que só 1 processo esteja ativo.
// ---------------------------------------------------------------------
const processedMessageIds = new Set();
const processedInteractionIds = new Set();

function markProcessedOnce(set, id, ttlMs = 60000) {
  if (set.has(id)) return false;
  set.add(id);
  setTimeout(() => set.delete(id), ttlMs);
  return true;
}

// ---------------------------------------------------------------------
// Estado em memória (rate limit, falhas seguidas, pendências e stats)
// NOTA: tudo aqui é perdido quando o processo reinicia. Se precisar que
// isso persista entre reinícios, isso deve ser movido para um banco
// (ex.: SQLite) — hoje o bot não usa nenhuma persistência em disco.
// ---------------------------------------------------------------------
const verificationAttempts = new Map(); // userId -> timestamps[] das últimas tentativas
const consecutiveFailures = new Map(); // userId -> nº de recusas seguidas
const pendingManualReviews = new Map(); // messageId (embed na staff) -> dados da pendência
const statsEvents = []; // { type, timestamp } de cada evento de verificação

function isRateLimited(userId) {
  const now = Date.now();
  const attempts = (verificationAttempts.get(userId) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  verificationAttempts.set(userId, attempts);
  return attempts.length >= RATE_LIMIT_MAX_ATTEMPTS;
}

function registerAttempt(userId) {
  const attempts = verificationAttempts.get(userId) || [];
  attempts.push(Date.now());
  verificationAttempts.set(userId, attempts);
}

function getRateLimitResetSeconds(userId) {
  const attempts = verificationAttempts.get(userId) || [];
  if (attempts.length === 0) return 0;
  const oldest = Math.min(...attempts);
  return Math.max(0, Math.ceil((RATE_LIMIT_WINDOW_MS - (Date.now() - oldest)) / 1000));
}

function registerFailure(userId) {
  const count = (consecutiveFailures.get(userId) || 0) + 1;
  consecutiveFailures.set(userId, count);
  return count;
}

function resetFailures(userId) {
  consecutiveFailures.delete(userId);
}

function recordStatEvent(type) {
  statsEvents.push({ type, timestamp: Date.now() });
}

function countStatEvents(type, sinceMs = null) {
  const since = sinceMs ? Date.now() - sinceMs : 0;
  return statsEvents.filter((e) => e.type === type && e.timestamp >= since).length;
}

async function sendDMNotification(user, approved, motivo = '') {
  try {
    const embed = new EmbedBuilder()
      .setColor(approved ? 0x2ecc71 : 0xe74c3c)
      .setTitle(approved ? '✅ Verificação Concluída' : '❌ Verificação Recusada')
      .setDescription(
        approved
          ? 'Sua inscrição no canal **Shai WZL** foi confirmada e seu acesso liberado!'
          : `Não foi possível aprovar sua verificação.\n**Motivo:** ${motivo}`
      )
      .setTimestamp();

    await user.send({ embeds: [embed] });
  } catch (err) {
    // Falha silenciosa caso o usuário esteja com DMs fechadas
  }
}

// ---------------------------------------------------------------------
// Solicitacao de Aprovação Manual (Enviar para a Staff)
// ---------------------------------------------------------------------

async function notifyStaffForManualReview(client, user, imageUrl) {
  try {
    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
    if (!staffChannel) return null;

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Solicitação de Aprovação Manual')
      .setDescription(
        `Ocorreu um erro durante a verificação do membro <@${user.id}> (ID \`${user.id}\`). O bot solicita inspeção manual.`
      )
      .setImage(imageUrl)
      .setColor('#a7a335')
      .setFooter({
        text: 'Print enviada',
      })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_approve:${user.id}`)
        .setLabel('Aprovar')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`staff_reject:${user.id}`)
        .setLabel('Recusar')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
    );

    const sentMessage = await staffChannel.send({
      content: `<@&${STAFF_ROLE_ID}>`,
      embeds: [embed],
      components: [row],
    });

    pendingManualReviews.set(sentMessage.id, {
      userId: user.id,
      username: user.tag || user.username,
      channelId: staffChannel.id,
      requestedAt: Date.now(),
    });

    return sentMessage;
  } catch (err) {
    console.error('[STAFF NOTIFY ERRO] Falha ao enviar solicitação para a staff:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// Envio do Embed de Logs
// ---------------------------------------------------------------------

async function sendLogEmbed(client, user, passed, durationSeconds, motivos = [], moderator = null) {
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel) return;

    const timestampSec = Math.floor(Date.now() / 1000);

    const logEmbed = new EmbedBuilder()
      .setColor(passed ? 0x2bd6fb : 0xe74c3c)
      .setTitle(passed ? 'Verificação Aprovada' : 'Verificação Recusada')
      .addFields(
        {
          name: '👤 Usuário',
          value: `<@${user.id}>\n(\`${user.username}\`)`,
          inline: true,
        },
        {
          name: '🆔 ID',
          value: `\`${user.id}\``,
          inline: true,
        },
        {
          name: '📅 Data',
          value: `<t:${timestampSec}:f>`,
          inline: true,
        }
      );

    if (durationSeconds) {
      logEmbed.addFields({
        name: '⏱️ Duração',
        value: `\`${durationSeconds}s\``,
        inline: true,
      });
    }

    if (moderator) {
      logEmbed.addFields({
        name: '🛡️ Verificação Manual',
        value: `Feita por <@${moderator.id}>`,
        inline: false,
      });
    }

    if (!passed && motivos.length > 0) {
      logEmbed.addFields({
        name: '❓ Motivo da Recusa',
        value: motivos.join('\n'),
        inline: false,
      });
    }

    logEmbed.setThumbnail(user.displayAvatarURL({ size: 256 }));
    logEmbed.setFooter({ text: 'Sistema de Verificação' }).setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });
  } catch (err) {
    console.error('[LOG ERRO] Falha ao enviar log para o canal do Discord:', err.message);
  }
}

// ---------------------------------------------------------------------
// Embed público de aprovação (/aprovar visivel:true)
// Usado quando a staff aprova alguém manualmente fora do canal de
// verificação (ex.: respondendo a um print em um ticket).
// ---------------------------------------------------------------------

async function sendPublicApprovalEmbed(interaction, targetUser) {
  const embed = new EmbedBuilder()
    .setColor(3455804)
    .setDescription(
      'Verificação concluída com sucesso!\n' +
        `- Agora, para obter acesso ao sistema, basta visitar o canal <#${ROLES_CHANNEL_ID}> e reivindicar seus cargos.`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(ROLES_BUTTON_URL)
      .setLabel('Receber os sistemas')
      .setEmoji('📋')
  );

  return interaction.followUp({
    content: `<@${targetUser.id}>`,
    embeds: [embed],
    components: [row],
  });
}

// ---------------------------------------------------------------------
// Chamada à API do OCR.space
// ---------------------------------------------------------------------

async function ocrFromImageUrl(imageUrl) {
  const params = new URLSearchParams({
    apikey: OCR_API_KEY,
    url: imageUrl,
    language: 'auto',
    OCREngine: '2',
    scale: 'true',
    isOverlayRequired: 'false',
  });

  const endpoint = `https://api.ocr.space/parse/imageurl?${params.toString()}`;
  const response = await fetch(endpoint, { method: 'GET' });

  if (!response.ok) throw new Error(`OCR.space respondeu HTTP ${response.status}`);

  const data = await response.json();
  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('; ') : data.ErrorMessage;
    throw new Error(`OCR.space retornou erro: ${msg || 'desconhecido'}`);
  }

  const parsedResults = data.ParsedResults || [];
  return parsedResults.map((r) => r.ParsedText || '').join('\n');
}

async function extractTextFromAttachment(attachmentUrl) {
  try {
    const text = await ocrFromImageUrl(attachmentUrl);
    if (text && text.trim().length > 0) return text;
  } catch (err) {
    console.warn(`[OCR] Fallback acionado: ${err.message}`);
  }

  const params = new URLSearchParams({
    apikey: OCR_API_KEY,
    url: attachmentUrl,
    language: 'por',
    OCREngine: '2',
    scale: 'true',
    isOverlayRequired: 'false',
  });
  const endpoint = `https://api.ocr.space/parse/imageurl?${params.toString()}`;
  const response = await fetch(endpoint, { method: 'GET' });
  
  if (!response.ok) throw new Error(`OCR.space respondeu HTTP ${response.status}`);
  
  const data = await response.json();
  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('; ') : data.ErrorMessage;
    throw new Error(`OCR.space retornou erro: ${msg || 'desconhecido'}`);
  }
  
  return (data.ParsedResults || []).map((r) => r.ParsedText || '').join('\n');
}

function evaluateOcrText(rawText) {
  const text = normalize(rawText);
  const foundChannelName = containsAny(text, CHANNEL_NAME_VARIANTS);
  const foundSubscribedWord = hasConfirmationWord(text);
  const foundNegative = containsAny(text, NOT_SUBSCRIBED_WORDS);

  return {
    passed: foundChannelName && foundSubscribedWord,
    foundChannelName,
    foundSubscribedWord,
    foundNegative,
    rawText,
  };
}

// ---------------------------------------------------------------------
// Cliente Discord otimizado (Poupa-RAM)
// ---------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    UserManager: 0,
    GuildMemberManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
    GuildBanManager: 0,
    PresenceManager: 0,
    VoiceStateManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: {
      interval: 60,
      lifetime: 10,
    },
  },
});

// Rede de segurança: evita que erros não tratados derrubem o processo inteiro.
// discord.js re-emite promises rejeitadas dentro de handlers como um evento
// 'error' no Client; sem um listener aqui, o Node trata isso como fatal.
client.on('error', (err) => {
  console.error('[CLIENT ERRO]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

// Registrar Slash Commands ao ligar o Bot
client.once('ready', async () => {
  console.log(`[INÍCIO] Bot online como: ${client.user.tag}`);

  // Função para atualizar a presença com a contagem real de membros
  const updatePresence = async () => {
    try {
      // Pega a guilda do bot (se você souber o GUILD_ID usa fetch, se não, pega a primeira)
      const guild = GUILD_ID 
        ? await client.guilds.fetch(GUILD_ID).catch(() => null) 
        : client.guilds.cache.first();

      if (guild) {
        // fetch() na guilda atualiza o memberCount sem carregar os membros na RAM
        const fullGuild = await guild.fetch();
        const memberCount = fullGuild.memberCount;

        client.user.setActivity({
          name: `🛠️ Shai | 👥 ${memberCount} membros`,
          type: ActivityType.Playing, // Define como "Jogando"
        });
      }
    } catch (err) {
      console.error('[PRESENÇA ERRO] Falha ao atualizar status:', err.message);
    }
  };

  // Executa imediatamente ao ligar
  await updatePresence();

  // Atualiza a contagem a cada 10 minutos (600.000 ms)
  setInterval(updatePresence, 600000);

  // Registro dos Slash Commands...
  const commands = [
    new SlashCommandBuilder()
      .setName('aprovar')
      .setDescription('Aprova manualmente um usuário na verificação')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((option) =>
        option.setName('usuario').setDescription('Usuário a ser aprovado').setRequired(true)
      )
      .addBooleanOption((option) =>
        option
          .setName('visivel')
          .setDescription('Enviar confirmação pública mencionando o usuário (ex: em tickets). Padrão: não.')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('recusar')
      .setDescription('Recusa manualmente um usuário na verificação')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((option) =>
        option.setName('usuario').setDescription('Usuário a ser recusado').setRequired(true)
      )
      .addStringOption((option) =>
        option.setName('motivo').setDescription('Motivo da recusa').setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('pendentes')
      .setDescription('Lista as verificações aguardando análise manual da staff')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Mostra estatísticas do sistema de verificação')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  ];

  try {
    await client.application.commands.set(commands);
    console.log('[SLASH] Comandos manuais (/aprovar, /recusar, /pendentes, /stats) registrados!');
  } catch (err) {
    console.error('[SLASH ERRO] Falha ao registrar comandos:', err.message);
  }
});

// ---------------------------------------------------------------------
// Handler de Comandos Slash (Verificação Manual)
// ---------------------------------------------------------------------
// Verifica se quem clicou/interagiu tem permissão de staff (cargo ou Manage Roles)
function isStaffMember(member) {
  if (!member) return false;
  if (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) return true;
  return member.permissions.has(PermissionFlagsBits.ManageRoles);
}

client.on('interactionCreate', async (interaction) => {
  if (!markProcessedOnce(processedInteractionIds, interaction.id)) return;

  // -----------------------------------------------------------------
  // Comandos Slash
  // -----------------------------------------------------------------
  if (interaction.isChatInputCommand()) {
    const { commandName, options, guild } = interaction;

    if (commandName === 'aprovar' || commandName === 'recusar') {
      // Acknowledge the interaction immediately (within Discord's 3s window).
      // Everything below can be slow (member fetch, role add, DM, log embed),
      // so we defer first and use editReply() from here on instead of reply().
      try {
        await interaction.deferReply();
      } catch (err) {
        console.error('[DEFER ERRO]', err.message);
        return; // token already dead, nothing more we can do
      }

      const targetUser = options.getUser('usuario');
      const member = await guild.members.fetch(targetUser.id).catch(() => null);

      if (!member) {
        return interaction.editReply({ content: '❌ Usuário não encontrado no servidor.' });
      }

      if (commandName === 'aprovar') {
        const visivel = options.getBoolean('visivel') ?? false;

        if (VERIFIED_ROLE_ID && !member.roles.cache.has(VERIFIED_ROLE_ID)) {
          await member.roles.add(VERIFIED_ROLE_ID).catch((err) =>
            console.error('[CARGO ERRO]', err.message)
          );
        }

        await sendDMNotification(targetUser, true);
        await sendLogEmbed(client, targetUser, true, null, [], interaction.user);
        recordStatEvent('manual_approved');
        resetFailures(targetUser.id);

        if (visivel) {
          await sendPublicApprovalEmbed(interaction, targetUser).catch((err) =>
            console.error('[EMBED PÚBLICO ERRO]', err.message)
          );
        }

        return interaction.editReply({
          content: `✅ <@${targetUser.id}> aprovado manualmente com sucesso por <@${interaction.user.id}>.`,
        });
      }

      if (commandName === 'recusar') {
        const motivo = options.getString('motivo') || 'Recusado manualmente pela moderação.';

        await sendDMNotification(targetUser, false, motivo);
        await sendLogEmbed(client, targetUser, false, null, [motivo], interaction.user);
        recordStatEvent('manual_rejected');

        return interaction.editReply({
          content: `❌ Verificação de <@${targetUser.id}> recusada por <@${interaction.user.id}>.`,
        });
      }
    }

    if (commandName === 'pendentes') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (pendingManualReviews.size === 0) {
        return interaction.editReply('✅ Não há verificações pendentes no momento.');
      }

      const linhas = [...pendingManualReviews.entries()]
        .sort((a, b) => a[1].requestedAt - b[1].requestedAt)
        .slice(0, 15)
        .map(([messageId, data]) => {
          const link = `https://discord.com/channels/${guild.id}/${data.channelId}/${messageId}`;
          const minutos = Math.floor((Date.now() - data.requestedAt) / 60000);
          return `• <@${data.userId}> — aguardando há **${minutos}min** — [ver solicitação](${link})`;
        });

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`⏳ Verificações pendentes (${pendingManualReviews.size})`)
        .setDescription(linhas.join('\n'))
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'stats') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const DIA_MS = 24 * 60 * 60 * 1000;
      const SEMANA_MS = 7 * DIA_MS;

      const linhaStats = (label, type) =>
        `**${label}**: hoje \`${countStatEvents(type, DIA_MS)}\` · 7 dias \`${countStatEvents(
          type,
          SEMANA_MS
        )}\` · total \`${countStatEvents(type)}\``;

      const embed = new EmbedBuilder()
        .setColor(0x2bd6fb)
        .setTitle('📊 Estatísticas de Verificação')
        .setDescription(
          [
            linhaStats('✅ Aprovados (automático)', 'auto_approved'),
            linhaStats('❌ Recusados (automático)', 'auto_rejected'),
            linhaStats('🛡️ Aprovados (manual)', 'manual_approved'),
            linhaStats('🛡️ Recusados (manual)', 'manual_rejected'),
            linhaStats('⚠️ Erros de OCR', 'ocr_error'),
            `\n⏳ Pendentes agora: \`${pendingManualReviews.size}\``,
          ].join('\n')
        )
        .setFooter({ text: 'Estatísticas contabilizadas desde a última inicialização do bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    return;
  }

  // -----------------------------------------------------------------
  // Botões "Aprovar" / "Recusar" no embed de análise manual (staff)
  // -----------------------------------------------------------------
  if (interaction.isButton()) {
    const [action, userId] = interaction.customId.split(':');
    if (action !== 'staff_approve' && action !== 'staff_reject') return;

    if (!isStaffMember(interaction.member)) {
      return interaction.reply({
        content: '❌ Você não tem permissão para usar este botão.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'staff_approve') {
      await interaction.deferUpdate();

      const targetUser = await client.users.fetch(userId).catch(() => null);
      const member = targetUser
        ? await interaction.guild.members.fetch(userId).catch(() => null)
        : null;

      if (!member || !targetUser) {
        return interaction.followUp({
          content: '❌ Usuário não encontrado no servidor.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (VERIFIED_ROLE_ID && !member.roles.cache.has(VERIFIED_ROLE_ID)) {
        await member.roles.add(VERIFIED_ROLE_ID).catch((err) =>
          console.error('[CARGO ERRO]', err.message)
        );
      }

      await sendDMNotification(targetUser, true);
      await sendLogEmbed(client, targetUser, true, null, [], interaction.user);
      recordStatEvent('manual_approved');
      resetFailures(userId);
      pendingManualReviews.delete(interaction.message.id);

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x2ecc71)
        .setFooter({ text: `✅ Aprovado por ${interaction.user.tag}` });

      return interaction.editReply({ embeds: [updatedEmbed], components: [] });
    }

    if (action === 'staff_reject') {
      // Abre um modal pra staff informar o motivo (opcional) antes de recusar
      const modal = new ModalBuilder()
        .setCustomId(`staff_reject_modal:${userId}`)
        .setTitle('Motivo da recusa');

      const motivoInput = new TextInputBuilder()
        .setCustomId('motivo')
        .setLabel('Motivo (opcional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Ex: print ilegível, não corresponde ao canal, etc.')
        .setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(motivoInput));

      return interaction.showModal(modal);
    }
  }

  // -----------------------------------------------------------------
  // Modal de motivo, enviado após clicar em "Recusar"
  // -----------------------------------------------------------------
  if (interaction.isModalSubmit()) {
    const [action, userId] = interaction.customId.split(':');
    if (action !== 'staff_reject_modal') return;

    if (!isStaffMember(interaction.member)) {
      return interaction.reply({
        content: '❌ Você não tem permissão para fazer isso.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const motivo = interaction.fields.getTextInputValue('motivo') || 'Recusado manualmente pela staff.';
    const targetUser = await client.users.fetch(userId).catch(() => null);

    if (targetUser) {
      await sendDMNotification(targetUser, false, motivo);
      await sendLogEmbed(client, targetUser, false, null, [motivo], interaction.user);
    }

    recordStatEvent('manual_rejected');
    pendingManualReviews.delete(interaction.message.id);

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xe74c3c)
      .setFooter({ text: `❌ Recusado por ${interaction.user.tag}` });

    return interaction.update({ embeds: [updatedEmbed], components: [] });
  }
});

// ---------------------------------------------------------------------
// Handler de Mensagens (Verificação Automática)
// ---------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!markProcessedOnce(processedMessageIds, message.id)) return;

    // -----------------------------------------------------------------
    // Sistema de Segurança / Canal Restrito (Honeypot)
    // -----------------------------------------------------------------
    if (message.channel.id === HONEYPOT_CHANNEL_ID) {
      console.log(`[SEGURANÇA] Violação detectada do usuário ${message.author.tag} (${message.author.id})`);

      const recentMessages = await message.channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recentMessages) {
        const userMsgs = recentMessages.filter((m) => m.author.id === message.author.id);
        if (userMsgs.size > 0) {
          await message.channel.bulkDelete(userMsgs).catch(() => {});
        }
      }

      await message.guild.members.kick(message.author.id, 'Segurança: Envio de mensagem em canal proibido/restrito')
        .then(() => console.log(`[SEGURANÇA] Usuário ${message.author.tag} expulso com sucesso.`))
        .catch((err) => console.error(`[SEGURANÇA ERRO] Não foi possível expulsar o usuário:`, err.message));

      return;
    }

    // -----------------------------------------------------------------
    // Canal de Verificação
    // -----------------------------------------------------------------
    if (message.channel.id !== VERIFICATION_CHANNEL_ID) return;

    const startTime = Date.now();

    const validAttachments = [...message.attachments.values()].filter((att) =>
      (att.contentType || '').startsWith('image/')
    );

    if (validAttachments.length === 0) {
      const aviso = await message.reply(
        '📎 Envie um **print de tela** mostrando o canal **Shai WZL** e o botão **"Inscrito"** para eu poder verificar.'
      );
      setTimeout(() => {
        aviso.delete().catch(() => {});
        message.delete().catch(() => {});
      }, 15000);
      return;
    }

    const imageAttachments = validAttachments.filter((att) => att.size <= MAX_FILE_SIZE_BYTES);

    if (imageAttachments.length === 0) {
      const aviso = await message.reply(
        `⚠️ A imagem enviada é muito grande! Envie um print com tamanho menor que **${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB**.`
      );
      setTimeout(() => {
        aviso.delete().catch(() => {});
        message.delete().catch(() => {});
      }, 15000);
      return;
    }

    if (isRateLimited(message.author.id)) {
      const resetSeconds = getRateLimitResetSeconds(message.author.id);
      const aviso = await message.reply(
        `🕒 Você atingiu o limite de **${RATE_LIMIT_MAX_ATTEMPTS} tentativas** em um curto período. Tente novamente em **${resetSeconds}s**.`
      );
      setTimeout(() => {
        aviso.delete().catch(() => {});
        message.delete().catch(() => {});
      }, 15000);
      return;
    }
    registerAttempt(message.author.id);

    await message.react('⏳').catch(() => {});

    let melhorResultado = null;

    for (const attachment of imageAttachments) {
      let text = '';
      try {
        text = await extractTextFromAttachment(attachment.url);
      } catch (err) {
        console.error(`[OCR ERRO] ${attachment.id}:`, err.message);
        continue;
      }

      const resultado = evaluateOcrText(text);
      if (resultado.passed) {
        melhorResultado = resultado;
        break;
      }
      if (!melhorResultado) {
        melhorResultado = resultado;
      }
    }

    await message.reactions.resolve('⏳')?.users.remove(client.user.id).catch(() => {});

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    // CASO DE ERRO DE LEITURA DA API / TIMEOUT
    if (!melhorResultado) {
      await message.react('⚠️').catch(() => {});

      const printUrl = imageAttachments[0].url;
      recordStatEvent('ocr_error');

      // 1. Envia notificação para o canal da Staff (com botões de aprovar/recusar)
      await notifyStaffForManualReview(client, message.author, printUrl);

      // 2. Avisa no canal de verificação
      const botReply = await message.reply(
        `⚠️ Ocorreu um erro ao tentar ler a sua imagem. Sua verificação foi encaminhada para a **STAFF** e, por demandar da equipe de suporte, a análise manual pode levar **algumas horas**.`
      );

      // 3. Avisa na DM do usuário
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('⚠️ Verificação Encaminhada para a Staff')
          .setDescription(
            'Houve um erro no processamento automático da sua imagem. Encaminhamos o seu print para a **STAFF** realizar a verificação manualmente. Por demandar da equipe de suporte, esse processo pode levar **algumas horas**.'
          )
          .setTimestamp();

        await message.author.send({ embeds: [dmEmbed] }).catch(() => {});
      } catch (err) {}

      scheduleMessageCleanup(message, botReply);
      return;
    }

    if (melhorResultado.passed) {
      await message.react('✅').catch(() => {});

      if (VERIFIED_ROLE_ID) {
        const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
        if (member && !member.roles.cache.has(VERIFIED_ROLE_ID)) {
          await member.roles.add(VERIFIED_ROLE_ID).catch((err) =>
            console.error('[CARGO ERRO]', err.message)
          );
        }
      }

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setDescription('Inscrição verificada com sucesso!');

      const botReply = await message.reply({ content: `${message.author}`, embeds: [embed] });
      scheduleMessageCleanup(message, botReply);

      await sendDMNotification(message.author, true);
      await sendLogEmbed(client, message.author, true, durationSeconds);
      recordStatEvent('auto_approved');
      resetFailures(message.author.id);

    } else {
      await message.react('❌').catch(() => {});

      const motivos = [];
      if (!melhorResultado.foundChannelName) motivos.push('Não encontrou o nome do canal (Shai WZL)');
      if (!melhorResultado.foundSubscribedWord) motivos.push('Não encontrou a confirmação de inscrito');

      const motivosTexto = motivos.join(' e ');

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setDescription(
          `❌ Não consegui confirmar sua inscrição.\n` +
          `Motivo: ${motivosTexto}.\n\n` +
          `Envie um print nítido mostrando o **nome do canal** e o **botão "Inscrito"** (com o sininho), sem cortar essa parte da tela.`
        );

      const botReply = await message.reply({ embeds: [embed] });
      scheduleMessageCleanup(message, botReply);

      await sendDMNotification(message.author, false, motivosTexto);
      await sendLogEmbed(client, message.author, false, durationSeconds, motivos);
      recordStatEvent('auto_rejected');

      const failureCount = registerFailure(message.author.id);
      if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
        resetFailures(message.author.id); // evita repetir o aviso a cada falha subsequente

        const avisoEmbed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setDescription(
            `${message.author}, você já teve **${failureCount} tentativas seguidas** sem sucesso.\n` +
              `Se estiver com dificuldade, recomendamos abrir um ticket com a **staff** para receber ajuda direta.`
          );

        const avisoMsg = await message.channel.send({ embeds: [avisoEmbed] });
        setTimeout(() => avisoMsg.delete().catch(() => {}), RESULT_CLEANUP_DELAY_MS * 2);
      }
    }
  } catch (err) {
    console.error('[ERRO GLOBAL]', err);
    await message.react('⚠️').catch(() => {});
  }
});

client.login(DISCORD_TOKEN);