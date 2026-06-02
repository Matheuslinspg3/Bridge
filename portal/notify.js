import nodemailer from 'nodemailer';

const ADMIN_EMAIL = 'matheuslinspg@gmail.com';

// Transporter: usa variáveis de ambiente ou fallback para log
let transporter = null;
try {
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
} catch (e) {
  console.warn('[portal/notify] SMTP not configured:', e.message);
}

export async function notifyNewOrder(order, user) {
  const subject = `[ClaudBridge] Novo pedido #${order.id} - ${order.plan_id}`;
  const text = [
    `Novo pedido criado!`,
    ``,
    `Cliente: ${user.name} (${user.email})`,
    `Plano: ${order.plan_id}`,
    `Valor: R$ ${order.amount_brl.toFixed(2)}`,
    `Data: ${order.created_at}`,
    ``,
    `Acesse o painel admin para confirmar o pagamento.`,
  ].join('\n');

  if (!transporter) {
    console.log(`[portal/notify] EMAIL (no SMTP):\n  To: ${ADMIN_EMAIL}\n  Subject: ${subject}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || ADMIN_EMAIL,
      to: ADMIN_EMAIL,
      subject,
      text,
    });
  } catch (e) {
    console.error('[portal/notify] Failed to send email:', e.message);
  }
}
