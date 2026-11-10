const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const AUTH_DIR = path.join(__dirname, 'auth_info');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Estado da Conexão
let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let connectedPhone = '';
let currentQrDataUrl = null;
let currentQrRaw = '';
let reconnectAttempts = 0;

// Formatador de número para o formato WhatsApp JID (ex: 5511999308909@s.whatsapp.net)
function formatPhoneToJid(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  
  // Se for celular de Angola e tiver 9 dígitos sem DDI
  if (digits.length === 9 && (digits.startsWith('9') || digits.startsWith('8'))) {
    digits = '244' + digits;
  }
  // Se for celular do Brasil sem DDI (10 ou 11 dígitos)
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    digits = '55' + digits;
  }

  return `${digits}@s.whatsapp.net`;
}

// Construtor de mensagens para clientes
function buildClientMessage(type, data) {
  data = data || {};
  const nome = data.userName || data.customerName || data.name || 'Cliente';
  const siteUrl = 'https://www.fabyshop.shop/perfil.html';

  switch (type) {
    case 'order_ff': {
      const pacote = (data.package || data.packageName || 'Diamantes Free Fire').replace(/\s*[Dd]iamantes/gi, '').trim() + ' Diamantes';
      const gameId = data.gameId || 'N/A';
      const gameNick = data.gameNick || 'N/A';
      const preco = data.price ? String(data.price).replace(/Kz/gi, '').trim() + ' Kz' : 'N/A';
      
      return `Olá, *${nome}*! 🎉\n\n` +
        `A sua recarga na *FABY SHOP* foi concluída com sucesso! 💎✨\n\n` +
        `📋 *Detalhes da Entrega:*\n` +
        `🎮 *ID Free Fire:* ${gameId}\n` +
        `👤 *Nick:* ${gameNick}\n` +
        `📦 *Pacote:* ${pacote}\n` +
        `💰 *Valor:* ${preco}\n` +
        `✅ *Status:* Concluído & Entregue no Jogo\n\n` +
        `Os seus diamantes já estão na sua conta! Acesse o histórico em:\n` +
        `👉 ${siteUrl}\n\n` +
        `Muito obrigado pela confiança e preferência! Bom jogo! 🔥`;
    }

    case 'giftcard': {
      const produto = data.productName || data.service || 'Gift Card';
      const pin = data.pin || data.code || 'Código disponível no site';
      const plano = data.plan ? ` (${data.plan})` : '';

      return `Olá, *${nome}*! 🎁\n\n` +
        `O seu pedido de *${produto}${plano}* na *FABY SHOP* foi concluído e emitido com sucesso! 🛍️\n\n` +
        `🔑 *Código / PIN de Ativação:*\n` +
        `\`${pin}\`\n\n` +
        `ℹ️ *Instruções:* Copie o código acima e resgate diretamente na sua conta da plataforma oficial.\n` +
        `Você também pode consultar o seu código no seu perfil da loja:\n` +
        `👉 ${siteUrl}\n\n` +
        `Agradecemos a sua preferência na FABY SHOP! Volte sempre! ✨`;
    }

    case 'streaming': {
      const produto = data.productName || data.service || 'Assinatura Streaming';
      const email = data.netflixEmail || data.email || 'N/A';
      const senha = data.netflixPassword || data.password || 'N/A';
      const perfil = data.netflixProfile || data.profile || 'Perfil 1';
      const pin = data.netflixPin || data.profilePin ? `PIN: ${data.netflixPin || data.profilePin}` : 'Sem PIN';
      const validade = data.expireDateStr || '30 Dias';

      return `Olá, *${nome}*! 🎬🍿\n\n` +
        `A sua assinatura de *${produto}* na *FABY SHOP* já está ativa e pronta para você assistir! 🎉\n\n` +
        `📋 *Dados de Acesso:*\n` +
        `📧 *E-mail / Login:* \`${email}\`\n` +
        `🔑 *Senha:* \`${senha}\`\n` +
        `👤 *Seu Perfil:* ${perfil} (${pin})\n` +
        `📅 *Validade:* ${validade}\n\n` +
        `⚠️ *Aviso Importante:*\n` +
        `• Utilize apenas o seu perfil designado.\n` +
        `• Não altere o email ou senha da conta compartilhada.\n\n` +
        `Acesse o seu histórico na FABY SHOP: 👉 ${siteUrl}\n\n` +
        `Tenha um ótimo entretenimento! 📺✨`;
    }

    case 'fc_deposit': {
      const amount = data.requestedFp || data.amount || '0';
      const preco = data.priceKz ? `${data.priceKz} Kz` : '';

      return `Olá, *${nome}*! 💰🎉\n\n` +
        `O seu carregamento de *${amount} Faby Coins (F€)* foi aprovado com sucesso na *FABY SHOP*!\n\n` +
        `💳 O saldo já se encontra creditado na sua carteira da loja.\n` +
        (preco ? `💵 *Valor Pago:* ${preco}\n` : '') +
        `🚀 Você já pode usar seus Faby Coins para comprar recargas instantâneas e Gift Cards no site!\n\n` +
        `Verifique o seu saldo atualizado em:\n` +
        `👉 ${siteUrl}\n\n` +
        `Obrigado por escolher a FABY SHOP! 🔥`;
    }

    default: {
      return `Olá, *${nome}*!\n\n` +
        `O seu pedido na *FABY SHOP* foi atualizado com sucesso! ✅\n` +
        `Acesse o seu perfil para acompanhar:\n` +
        `👉 ${siteUrl}`;
    }
  }
}

// Inicia a Conexão com o WhatsApp via Baileys
async function startWhatsAppBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }));

    console.log(`[WhatsApp Bot] Iniciando Baileys v${version.join('.')} (Última: ${isLatest})...`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['FABY SHOP Notifier', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrRaw = qr;
        connectionStatus = 'connecting';
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
        } catch (e) {
          console.error('[WhatsApp Bot] Erro ao gerar imagem QR:', e);
        }

        console.log('\n======================================================');
        console.log('📱 ESCANEIE O QR CODE COM O WHATSAPP (+55 11999308909):');
        console.log('======================================================\n');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('\nOu acesse no navegador: http://localhost:' + PORT);
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        currentQrDataUrl = null;
        currentQrRaw = '';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WhatsApp Bot] ⚠️ Conexão encerrada (Status: ${statusCode}). Reconectar? ${shouldReconnect}`);

        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 3000, 15000);
          console.log(`[WhatsApp Bot] Tentando reconectar em ${delay / 1000}s...`);
          setTimeout(startWhatsAppBot, delay);
        } else {
          console.log('[WhatsApp Bot] ❌ Sessão desconectada pelo usuário. Limpando credenciais antigas...');
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
          reconnectAttempts = 0;
          setTimeout(startWhatsAppBot, 3000);
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        connectionStatus = 'connected';
        currentQrDataUrl = null;
        currentQrRaw = '';
        connectedPhone = (sock.user?.id || '').split(':')[0].split('@')[0];

        console.log('\n======================================================');
        console.log(`[WhatsApp Bot] 🟢 CONECTADO COM SUCESSO!`);
        console.log(`[WhatsApp Bot] 📱 Número Ativo: +${connectedPhone}`);
        console.log(`[WhatsApp Bot] 🚀 Pronto para enviar notificações automáticas!`);
        console.log('======================================================\n');
      }
    });

  } catch (err) {
    console.error('[WhatsApp Bot] Erro ao iniciar cliente:', err);
    setTimeout(startWhatsAppBot, 5000);
  }
}

// ─── ENDPOINTS DA API HTTP ───

// Status da Conexão
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    phone: connectedPhone ? `+${connectedPhone}` : null,
    qr: currentQrDataUrl
  });
});

// Envio de Mensagem Genérica
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'Os campos "phone" e "message" são obrigatórios.' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'O WhatsApp Bot não está conectado no momento. Conecte pelo QR Code primeiro.' });
  }

  const jid = formatPhoneToJid(phone);
  if (!jid) {
    return res.status(400).json({ error: 'Número de WhatsApp inválido.' });
  }

  try {
    const result = await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp Bot] ✉️ Mensagem enviada para ${jid}`);
    return res.json({ success: true, jid, messageId: result?.key?.id });
  } catch (error) {
    console.error(`[WhatsApp Bot] ❌ Erro ao enviar mensagem para ${jid}:`, error);
    return res.status(500).json({ error: 'Falha ao enviar mensagem via WhatsApp: ' + error.message });
  }
});

// Envio Formatado de Notificação de Pedido / Depósito
app.post('/api/send-order', async (req, res) => {
  const { type, phone, orderData } = req.body;
  if (!type || !phone) {
    return res.status(400).json({ error: 'Os campos "type" e "phone" são obrigatórios.' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'O WhatsApp Bot não está conectado no momento.' });
  }

  const jid = formatPhoneToJid(phone);
  if (!jid) {
    return res.status(400).json({ error: 'Número de telefone inválido.' });
  }

  const messageText = buildClientMessage(type, orderData);

  try {
    const result = await sock.sendMessage(jid, { text: messageText });
    console.log(`[WhatsApp Bot] 🚀 Notificação [${type}] enviada com sucesso para ${jid}`);
    return res.json({ success: true, jid, messageId: result?.key?.id });
  } catch (error) {
    console.error(`[WhatsApp Bot] ❌ Erro ao enviar notificação de pedido:`, error);
    return res.status(500).json({ error: 'Falha ao disparar mensagem: ' + error.message });
  }
});

// Desconectar / Trocar de Número
app.post('/api/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    connectionStatus = 'disconnected';
    connectedPhone = '';
    currentQrDataUrl = null;
    currentQrRaw = '';
    console.log('[WhatsApp Bot] Sessão desconectada e credenciais removidas.');
    setTimeout(startWhatsAppBot, 1500);
    return res.json({ success: true, message: 'Desconectado com sucesso. Novo QR Code será gerado.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Inicia o Servidor HTTP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`======================================================`);
  console.log(`🤖 FABY SHOP - WHATSAPP BOT API`);
  console.log(`🌐 Painel Visual: http://127.0.0.1:${PORT}`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`======================================================`);
  startWhatsAppBot();

  // Auto-Ping para manter o servidor acordado 24h caso hospedado no Render / Nuvem
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (externalUrl) {
    console.log(`[Keep-Alive] Configurado auto-ping a cada 10 min para: ${externalUrl}`);
    setInterval(() => {
      fetch(`${externalUrl}/api/status`)
        .then(() => console.log(`[Keep-Alive] ⏰ Auto-ping executado (${new Date().toLocaleTimeString()})`))
        .catch(err => console.warn('[Keep-Alive] Falha no auto-ping:', err.message));
    }, 10 * 60 * 1000);
  }

  // Abre o navegador automaticamente apenas em ambiente local Windows
  setTimeout(() => {
    try {
      const { exec } = require('child_process');
      if (process.platform === 'win32' && !process.env.RENDER) {
        exec(`start http://127.0.0.1:${PORT}`);
      }
    } catch (e) {}
  }, 800);
});

