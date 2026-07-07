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
      <!-- Preheader (preview text) -->
      <div style="display:none;max-height:0px;overflow:hidden;">Redefinição de senha — crie uma nova senha para sua conta Systa Prospect.</div>

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background: #F6F5F8; padding: 24px 0; font-family: 'Plus Jakarta Sans', sans-serif;">
        <tr>
          <td align="center">
            <table role="presentation" width="480" cellspacing="0" cellpadding="0" style="background: #ffffff; border-radius: 12px; padding: 28px;">
              <tr>
                <td style="text-align: center; padding-bottom: 8px;">
                  <div style="display:inline-flex;align-items:center;gap:12px;justify-content:center;">
                    <div style="width:36px;height:36px;border-radius:8px;background:#6C2BD9;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;">SL</div>
                    <div style="font-size:16px;color:#2A1140;font-weight:700;">Systa Leads</div>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding-top: 12px;">
                  <h1 style="font-size:20px;color:#2A1140;margin:0 0 12px 0;">Redefinição de senha</h1>
                  <p style="color:#4B4450;font-size:15px;line-height:1.6;margin:0;">
                    Recebemos uma solicitação para redefinir a senha da sua conta Systa Leads. Clique no botão abaixo para criar uma nova senha.
                  </p>

                  <div style="text-align:center;margin:22px 0;">
                    <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;background:#6C2BD9;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">Redefinir senha</a>
                  </div>

                  <p style="color:#7A7280;font-size:13px;line-height:1.5;margin:0 0 18px 0;">Este link expira em 1 hora. Se você não solicitou a redefinição, ignore este e-mail.</p>
                  <hr style="border:none;border-top:1px solid #F0E8E3;margin:18px 0;" />
                  <p style="color:#9B94A0;font-size:12px;margin:0;">Se precisar de ajuda, contate <a href="${process.env.APP_URL ?? '#'}" style="color:#6C2BD9;text-decoration:none;">suporte</a>.</p>
                </td>
              </tr>
              <tr>
                <td style="padding-top:18px;text-align:center;color:#9B94A0;font-size:12px;">Systa Prospect — <span style="color:#7A7280">&copy; ${new Date().getFullYear()}</span></td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `,
  });

  return nodemailer.getTestMessageUrl(info);
}
