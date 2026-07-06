import nodemailer from 'nodemailer';

function createTransporter() {
  const secure = process.env.SMTP_SECURE === 'true';
  const certSecure = process.env.TRUST_SMTP === 'true';

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure,
    tls: {
      rejectUnauthorized: certSecure,
    },
    // Prevents silently falling back to plaintext if STARTTLS negotiation
    // is stripped (e.g. active MITM) when not using implicit TLS.
    requireTLS: !secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
): Promise<string | false> {
  const transporter = createTransporter();

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: 'Redefinição de senha — Systa',
    html: `
      <div style="font-family: 'Plus Jakarta Sans', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #fff; border-radius: 12px;">
        <h1 style="font-size: 20px; color: #3D2B1F; margin-bottom: 16px;">Redefinição de senha</h1>
        <p style="color: #6B5B4E; font-size: 15px; line-height: 1.6;">
          Recebemos uma solicitação para redefinir a senha da sua conta.
          Clique no botão abaixo para criar uma nova senha.
        </p>
        <a href="${resetUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 28px; background: #3D2B1F; color: #fff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600;">
          Redefinir senha
        </a>
        <p style="color: #9C8C82; font-size: 13px; line-height: 1.5;">
          Este link expira em 1 hora. Se você não solicitou a redefinição, ignore este e-mail.
        </p>
        <hr style="border: none; border-top: 1px solid #F0E8E3; margin: 24px 0;" />
        <p style="color: #C4B5AD; font-size: 12px;">Systa Prospect</p>
      </div>
    `,
  });

  return nodemailer.getTestMessageUrl(info);
}
