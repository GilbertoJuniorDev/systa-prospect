import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { authenticate } from '../lib/authenticate';
import { addCredits } from '../lib/credits';

const PACKAGES = {
  starter: { credits: 50,  price: 2900,  label: '50 créditos' },
  pro:     { credits: 150, price: 5900,  label: '150 créditos' },
  max:     { credits: 500, price: 14900, label: '500 créditos' },
} as const;

type PackageId = keyof typeof PACKAGES;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-06-24.dahlia',
});

export async function creditsRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── Webhook (sem autenticação, recebe raw body) ───────────────────────────
  // Registrado em sub-plugin isolado para ter seu próprio content-type parser
  fastify.register(async (webhookApp: FastifyInstance) => {
    webhookApp.removeAllContentTypeParsers();
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      function (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body: Buffer) => void) {
        done(null, body);
      },
    );

    webhookApp.post('/stripe/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
      const sig = request.headers['stripe-signature'] as string;
      const rawBody = (request.body as Buffer).toString('utf8');

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          rawBody,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET!,
        );
      } catch (err) {
        fastify.log.error({ err }, 'stripe webhook: signature verification failed');
        return reply.status(400).send({ error: 'invalid_signature' });
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId  = session.metadata?.userId;
        const credits = Number(session.metadata?.credits);

        if (!userId || !(credits > 0)) {
          fastify.log.warn({ sessionId: session.id, userId, credits }, 'stripe webhook: missing metadata');
        } else {
          try {
            await addCredits(userId, credits, 'STRIPE_PURCHASE', 'Compra via Stripe', session.id);
            fastify.log.info({ userId, credits, sessionId: session.id }, 'stripe webhook: credits added');
          } catch (err) {
            fastify.log.error({ err, userId, credits, sessionId: session.id }, 'stripe webhook: addCredits failed');
            return reply.status(500).send({ error: 'internal_error' });
          }
        }
      }

      return reply.status(200).send({ received: true });
    });
  });

  // ─── GET /user/credits ─────────────────────────────────────────────────────
  fastify.get(
    '/user/credits',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.user;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          credits: true,
          creditTransactions: {
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
              id: true,
              amount: true,
              type: true,
              description: true,
              createdAt: true,
              paramsHash: true,
            },
          },
        },
      });

      if (!user) {
        return reply.status(404).send({ error: 'user_not_found' });
      }

      // Batch lookup dos caches vinculados às transações de exportação
      const hashes = user.creditTransactions
        .map((tx) => tx.paramsHash)
        .filter((h): h is string => h !== null && h !== undefined);

      const caches = hashes.length > 0
        ? await prisma.consultaCache.findMany({
            where: { userId, paramsHash: { in: hashes } },
            select: { paramsHash: true, params: true, total: true, expiresAt: true },
          })
        : [];

      const cacheMap = new Map(caches.map((c) => [c.paramsHash, c]));

      const transactions = user.creditTransactions.map(({ paramsHash, ...tx }) => ({
        ...tx,
        consultaCache: paramsHash ? (cacheMap.get(paramsHash) ?? null) : null,
      }));

      return {
        balance: user.credits,
        transactions,
      };
    },
  );

  // ─── POST /stripe/create-checkout ─────────────────────────────────────────
  fastify.post<{ Body: { packageId: string } }>(
    '/stripe/create-checkout',
    {
      preHandler: [authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['packageId'],
          properties: {
            packageId: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { packageId: string } }>, reply: FastifyReply) => {
      const { packageId } = request.body;

      if (!(packageId in PACKAGES)) {
        return reply.status(400).send({ error: 'invalid_package' });
      }

      const pkg = PACKAGES[packageId as PackageId];
      const { userId } = request.user;

      const frontendUrl = process.env.APP_FRONTEND_URL ?? 'http://localhost:3000';

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        currency: 'brl',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'brl',
              unit_amount: pkg.price,
              product_data: {
                name: pkg.label,
              },
            },
          },
        ],
        success_url: `${frontendUrl}/creditos?success=true`,
        cancel_url:  `${frontendUrl}/creditos?canceled=true`,
        metadata: {
          userId,
          credits: String(pkg.credits),
        },
      });

      return { url: session.url };
    },
  );
}
