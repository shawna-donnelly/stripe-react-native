// Server code from https://github.com/stripe-samples/accept-a-card-payment/tree/master/using-webhooks/server/node-typescript

import env from 'dotenv';
// Replace if using a different env file or config.
env.config({ path: './.env' });

import bodyParser from 'body-parser';
import express from 'express';

import Stripe from 'stripe';
import Okta, { okta } from '@okta/okta-sdk-nodejs';

import { generateResponse } from './utils';

const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const oktaApiToken = process.env.OKTA_API_KEY || '';

const app = express();

app.use(
  (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    if (req.originalUrl === '/webhook') {
      next();
    } else {
      /* @ts-ignore */
      bodyParser.json()(req, res, next);
    }
  }
);

// tslint:disable-next-line: interface-name
const itemIdToPrice: { [id: string]: number } = {
  'id-1': 1400,
  'id-2': 2000,
  'id-3': 3000,
  'id-4': 4000,
  'id-5': 5000,
};

const calculateOrderAmount = (itemIds: string[] = ['id-1']): number => {
  const total = itemIds
    .map((id) => itemIdToPrice[id])
    .reduce((prev, curr) => prev + curr, 0);

  return total;
};

function getKeys(payment_method?: string) {
  let secret_key: string | undefined = stripeSecretKey;
  let publishable_key: string | undefined = stripePublishableKey;

  switch (payment_method) {
    case 'grabpay':
    case 'fpx':
      publishable_key = process.env.STRIPE_PUBLISHABLE_KEY_MY;
      secret_key = process.env.STRIPE_SECRET_KEY_MY;
      break;
    case 'au_becs_debit':
      publishable_key = process.env.STRIPE_PUBLISHABLE_KEY_AU;
      secret_key = process.env.STRIPE_SECRET_KEY_AU;
      break;
    case 'oxxo':
      publishable_key = process.env.STRIPE_PUBLISHABLE_KEY_MX;
      secret_key = process.env.STRIPE_SECRET_KEY_MX;
      break;
    case 'wechat_pay':
      publishable_key = process.env.STRIPE_PUBLISHABLE_KEY_WECHAT;
      secret_key = process.env.STRIPE_SECRET_KEY_WECHAT;
      break;
    case 'paypal':
      publishable_key = process.env.STRIPE_PUBLISHABLE_KEY_UK;
      secret_key = process.env.STRIPE_SECRET_KEY_UK;
      break;
    default:
      publishable_key = process.env.STRIPE_PUBLISHABLE_KEY;
      secret_key = process.env.STRIPE_SECRET_KEY;
  }

  return { secret_key, publishable_key };
}

app.get(
  '/stripe-key',
  (req: express.Request, res: express.Response): express.Response<any> => {
    const { publishable_key } = getKeys(req.query.paymentMethod as string);

    return res.send({ publishableKey: publishable_key });
  }
);

app.post(
  '/create-payment-intent',
  async (
    req: express.Request,
    res: express.Response
  ): Promise<express.Response<any>> => {
    const {
      email,
      items,
      currency,
      request_three_d_secure,
      payment_method_types = [],
      client = 'ios',
    }: {
      email: string;
      items: string[];
      currency: string;
      payment_method_types: string[];
      request_three_d_secure: 'any' | 'automatic';
      client: 'ios' | 'android';
    } = req.body;

    const { secret_key } = getKeys(payment_method_types[0]);

    const stripe = new Stripe(secret_key as string, {
      apiVersion: '2022-11-15',
      typescript: true,
    });

    const customer = await stripe.customers.create({ email });
    // Create a PaymentIntent with the order amount and currency.
    const params: Stripe.PaymentIntentCreateParams = {
      amount: calculateOrderAmount(items),
      currency,
      customer: customer.id,
      payment_method_options: {
        card: {
          request_three_d_secure: request_three_d_secure || 'automatic',
        },
        sofort: {
          preferred_language: 'en',
        },
        wechat_pay: {
          app_id: 'wx65907d6307c3827d',
          client: client,
        },
      },
      payment_method_types: payment_method_types,
    };

    try {
      const paymentIntent: Stripe.PaymentIntent =
        await stripe.paymentIntents.create(params);
      // Send publishable key and PaymentIntent client_secret to client.
      return res.send({
        clientSecret: paymentIntent.client_secret,
      });
    } catch (error: any) {
      return res.send({
        error: error.raw.message,
      });
    }
  }
);

app.post(
  '/create-payment-intent-with-payment-method',
  async (
    req: express.Request,
    res: express.Response
  ): Promise<express.Response<any>> => {
    const {
      items,
      currency,
      request_three_d_secure,
      email,
    }: {
      items: string[];
      currency: string;
      request_three_d_secure: 'any' | 'automatic';
      email: string;
    } = req.body;
    const { secret_key } = getKeys();

    const stripe = new Stripe(secret_key as string, {
      apiVersion: '2022-11-15',
      typescript: true,
    });
    const customers = await stripe.customers.list({
      email,
    });

    // The list all Customers endpoint can return multiple customers that share the same email address.
    // For this example we're taking the first returned customer but in a production integration
    // you should make sure that you have the right Customer.
    if (!customers.data[0]) {
      return res.send({
        error: 'There is no associated customer object to the provided e-mail',
      });
    }
    // List the customer's payment methods to find one to charge
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customers.data[0].id,
      type: 'card',
    });

    if (!paymentMethods.data[0]) {
      return res.send({
        error: `There is no associated payment method to the provided customer's e-mail`,
      });
    }

    const params: Stripe.PaymentIntentCreateParams = {
      amount: calculateOrderAmount(items),
      currency,
      payment_method_options: {
        card: {
          request_three_d_secure: request_three_d_secure || 'automatic',
        },
      },
      payment_method: paymentMethods.data[0].id,
      customer: customers.data[0].id,
    };

    const paymentIntent: Stripe.PaymentIntent =
      await stripe.paymentIntents.create(params);

    // Send publishable key and PaymentIntent client_secret to client.
    return res.send({
      clientSecret: paymentIntent.client_secret,
      paymentMethodId: paymentMethods.data[0].id,
    });
  }
);

app.post(
  '/pay-without-webhooks',
  async (
    req: express.Request,
    res: express.Response
  ): Promise<express.Response<any>> => {
    const {
      paymentMethodId,
      paymentIntentId,
      items,
      currency,
      useStripeSdk,
      cvcToken,
      email,
    }: {
      paymentMethodId?: string;
      paymentIntentId?: string;
      cvcToken?: string;
      items: string[];
      currency: string;
      useStripeSdk: boolean;
      email?: string;
    } = req.body;

    const orderAmount: number = calculateOrderAmount(items);
    const { secret_key } = getKeys();

    const stripe = new Stripe(secret_key as string, {
      apiVersion: '2022-11-15',
      typescript: true,
    });

    try {
      if (cvcToken && email) {
        const customers = await stripe.customers.list({
          email,
        });

        // The list all Customers endpoint can return multiple customers that share the same email address.
        // For this example we're taking the first returned customer but in a production integration
        // you should make sure that you have the right Customer.
        if (!customers.data[0]) {
          return res.send({
            error:
              'There is no associated customer object to the provided e-mail',
          });
        }

        const paymentMethods = await stripe.paymentMethods.list({
          customer: customers.data[0].id,
          type: 'card',
        });

        if (!paymentMethods.data[0]) {
          return res.send({
            error: `There is no associated payment method to the provided customer's e-mail`,
          });
        }

        const params: Stripe.PaymentIntentCreateParams = {
          amount: orderAmount,
          confirm: true,
          confirmation_method: 'manual',
          currency,
          payment_method: paymentMethods.data[0].id,
          payment_method_options: {
            card: {
              cvc_token: cvcToken,
            },
          },
          use_stripe_sdk: useStripeSdk,
          customer: customers.data[0].id,
          return_url: 'stripe-example://stripe-redirect',
        };
        const intent = await stripe.paymentIntents.create(params);
        return res.send(generateResponse(intent));
      } else if (paymentMethodId) {
        // Create new PaymentIntent with a PaymentMethod ID from the client.
        const params: Stripe.PaymentIntentCreateParams = {
          amount: orderAmount,
          confirm: true,
          confirmation_method: 'manual',
          currency,
          payment_method: paymentMethodId,
          // If a mobile client passes `useStripeSdk`, set `use_stripe_sdk=true`
          // to take advantage of new authentication features in mobile SDKs.
          use_stripe_sdk: useStripeSdk,
          return_url: 'stripe-example://stripe-redirect',
        };
        const intent = await stripe.paymentIntents.create(params);
        // After create, if the PaymentIntent's status is succeeded, fulfill the order.
        return res.send(generateResponse(intent));
      } else if (paymentIntentId) {
        // Confirm the PaymentIntent to finalize payment after handling a required action
        // on the client.
        const intent = await stripe.paymentIntents.confirm(paymentIntentId);
        // After confirm, if the PaymentIntent's status is succeeded, fulfill the order.
        return res.send(generateResponse(intent));
      }

      return res.sendStatus(400);
    } catch (e: any) {
      // Handle "hard declines" e.g. insufficient funds, expired card, etc
      // See https://stripe.com/docs/declines/codes for more.
      return res.send({ error: e.message });
    }
  }
);

app.post('/create-setup-intent', async (req, res) => {
  const {
    email,
    payment_method_types = [],
  }: { email: string; payment_method_types: string[] } = req.body;
  const { secret_key } = getKeys(payment_method_types[0]);

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });
  const customer = await stripe.customers.create({ email });

  const payPalIntentPayload = {
    return_url: 'https://example.com/setup/complete',
    payment_method_options: { paypal: { currency: 'eur' } },
    payment_method_data: { type: 'paypal' },
    mandate_data: {
      customer_acceptance: {
        type: 'online',
        online: {
          ip_address: '1.1.1.1',
          user_agent: 'test-user-agent',
        },
      },
    },
    confirm: true,
  };

  //@ts-ignore
  const setupIntent = await stripe.setupIntents.create({
    ...{ customer: customer.id, payment_method_types },
    ...(payment_method_types?.includes('paypal') ? payPalIntentPayload : {}),
  });

  // Send publishable key and SetupIntent details to client
  return res.send({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    clientSecret: setupIntent.client_secret,
  });
});

// Expose a endpoint as a webhook handler for asynchronous events.
// Configure your webhook in the stripe developer dashboard:
// https://dashboard.stripe.com/test/webhooks
app.post(
  '/webhook',
  // Use body-parser to retrieve the raw body as a buffer.
  /* @ts-ignore */
  bodyParser.raw({ type: 'application/json' }),
  async (
    req: express.Request,
    res: express.Response
  ): Promise<express.Response<any>> => {
    // Retrieve the event by verifying the signature using the raw body and secret.
    let event: Stripe.Event;
    const { secret_key } = getKeys();

    const stripe = new Stripe(secret_key as string, {
      apiVersion: '2022-11-15',
      typescript: true,
    });
    // console.log('webhook!', req);
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'] || [],
        stripeWebhookSecret
      );
      console.log({ event }, event.data);
    } catch (err) {
      console.log(`⚠️  Webhook signature verification failed.`);
      return res.sendStatus(400);
    }

    // Extract the data from the event.
    const data: Stripe.Event.Data = event.data;
    const eventType: string = event.type;

    if (eventType === 'payment_intent.succeeded') {
      // Cast the event into a PaymentIntent to make use of the types.
      const pi: Stripe.PaymentIntent = data.object as Stripe.PaymentIntent;

      // Funds have been captured
      // Fulfill any orders, e-mail receipts, etc
      // To cancel the payment after capture you will need to issue a Refund (https://stripe.com/docs/api/refunds).
      console.log(`🔔  Webhook received: ${pi.object} ${pi.status}!`);
      console.log('💰 Payment captured!');
    }
    if (eventType === 'payment_intent.payment_failed') {
      // Cast the event into a PaymentIntent to make use of the types.
      const pi: Stripe.PaymentIntent = data.object as Stripe.PaymentIntent;
      console.log(`🔔  Webhook received: ${pi.object} ${pi.status}!`);
      console.log('❌ Payment failed.');
    }

    if (eventType === 'setup_intent.setup_failed') {
      console.log(`🔔  A SetupIntent has failed the to setup a PaymentMethod.`);
    }

    if (eventType === 'setup_intent.succeeded') {
      console.log(
        `🔔  A SetupIntent has successfully setup a PaymentMethod for future use.`
      );
    }

    if (eventType === 'setup_intent.created') {
      const setupIntent: Stripe.SetupIntent = data.object as Stripe.SetupIntent;
      console.log(`🔔  A new SetupIntent is created. ${setupIntent.id}`);
    }

    // Handle the event
    switch (event.type) {
      case 'setup_intent.created':
        const setupIntentCreated = event.data.object;
        console.log({ setupIntentCreated });
        // Then define and call a function to handle the event customer.subscription.created
        break;
      case 'customer.subscription.created':
        const customerSubscriptionCreated = event.data.object;
        console.log({ customerSubscriptionCreated });
        // Then define and call a function to handle the event customer.subscription.created
        break;
      case 'customer.subscription.deleted':
        const customerSubscriptionDeleted = event.data.object;
        console.log({ customerSubscriptionDeleted });
        // Then define and call a function to handle the event customer.subscription.deleted
        break;
      case 'customer.subscription.paused':
        const customerSubscriptionPaused = event.data.object;
        console.log({ customerSubscriptionPaused });
        // Then define and call a function to handle the event customer.subscription.paused
        break;
      case 'customer.subscription.pending_update_applied':
        const customerSubscriptionPendingUpdateApplied = event.data.object;
        console.log({ customerSubscriptionPendingUpdateApplied });
        // Then define and call a function to handle the event customer.subscription.pending_update_applied
        break;
      case 'customer.subscription.pending_update_expired':
        const customerSubscriptionPendingUpdateExpired = event.data.object;
        console.log({ customerSubscriptionPendingUpdateExpired });
        // Then define and call a function to handle the event customer.subscription.pending_update_expired
        break;
      case 'customer.subscription.trial_will_end':
        const customerSubscriptionTrialWillEnd = event.data.object;
        console.log({ customerSubscriptionTrialWillEnd });
        // Then define and call a function to handle the event customer.subscription.trial_will_end
        break;
      case 'customer.subscription.updated':
        const customerSubscriptionUpdated = event.data.object;
        console.log({ customerSubscriptionUpdated });
        if (customerSubscriptionUpdated.status === 'active') {
          const oktaClient = new Okta.Client({
            orgUrl: 'https://dev-02732928.okta.com',
            token: oktaApiToken, // Obtained from Developer Dashboard
          });

          const user = await oktaClient.userApi.listUsers({
            search: `profile.stripeCustomerId eq ${customerSubscriptionUpdated.customer}`,
          });

          console.log('USER RESPONSE');
          console.log(user);

          // await oktaClient.groupApi
          //   .assignUserToGroup({
          //     groupId: '00gaovc7f4wTkciaW5d7',
          //     userId: user?.[0].id,
          //   })
          //   .catch((e) => console.log('error adding to group' + e.message));
        }
        // Then define and call a function to handle the event customer.subscription.updated
        break;
      // ... handle other event types
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    return res.sendStatus(200);
  }
);

// An endpoint to charge a saved card
// In your application you may want a cron job / other internal process
app.post('/charge-card-off-session', async (req, res) => {
  let paymentIntent, customer;

  const { secret_key } = getKeys();

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  try {
    // You need to attach the PaymentMethod to a Customer in order to reuse
    // Since we are using test cards, create a new Customer here
    // You would do this in your payment flow that saves cards
    customer = await stripe.customers.list({
      email: req.body.email,
    });

    // List the customer's payment methods to find one to charge
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer.data[0].id,
      type: 'card',
    });

    // Create and confirm a PaymentIntent with the order amount, currency,
    // Customer and PaymentMethod ID
    paymentIntent = await stripe.paymentIntents.create({
      amount: calculateOrderAmount(),
      currency: 'usd',
      payment_method: paymentMethods.data[0].id,
      customer: customer.data[0].id,
      off_session: true,
      confirm: true,
    });

    return res.send({
      succeeded: true,
      clientSecret: paymentIntent.client_secret,
      publicKey: stripePublishableKey,
    });
  } catch (err: any) {
    if (err.code === 'authentication_required') {
      // Bring the customer back on-session to authenticate the purchase
      // You can do this by sending an email or app notification to let them know
      // the off-session purchase failed
      // Use the PM ID and client_secret to authenticate the purchase
      // without asking your customers to re-enter their details
      return res.send({
        error: 'authentication_required',
        paymentMethod: err.raw.payment_method.id,
        clientSecret: err.raw.payment_intent.client_secret,
        publicKey: stripePublishableKey,
        amount: calculateOrderAmount(),
        card: {
          brand: err.raw.payment_method.card.brand,
          last4: err.raw.payment_method.card.last4,
        },
      });
    } else if (err.code) {
      // The card was declined for other reasons (e.g. insufficient funds)
      // Bring the customer back on-session to ask them for a new payment method
      return res.send({
        error: err.code,
        clientSecret: err.raw.payment_intent.client_secret,
        publicKey: stripePublishableKey,
      });
    } else {
      console.log('Unknown error occurred', err);
      return res.sendStatus(500);
    }
  }
});

// This example sets up an endpoint using the Express framework.
// Watch this video to get started: https://youtu.be/rPR2aJ6XnAc.

app.post('/payment-sheet', async (_, res) => {
  const { secret_key } = getKeys();

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  const customers = await stripe.customers.list();

  // Here, we're getting latest customer only for example purposes.
  const customer = customers.data[0];

  if (!customer) {
    return res.send({
      error: 'You have no customer created',
    });
  }

  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customer.id },
    { apiVersion: '2022-11-15' }
  );
  const paymentIntent = await stripe.paymentIntents.create({
    amount: 5099,
    currency: 'usd',
    customer: customer.id,
    // Edit the following to support different payment methods in your PaymentSheet
    // Note: some payment methods have different requirements: https://stripe.com/docs/payments/payment-methods/integration-options
    payment_method_types: [
      'card',
      // 'ideal',
      // 'sepa_debit',
      // 'sofort',
      // 'bancontact',
      // 'p24',
      // 'giropay',
      // 'eps',
      // 'afterpay_clearpay',
      // 'klarna',
      // 'us_bank_account',
    ],
  });
  return res.json({
    paymentIntent: paymentIntent.client_secret,
    ephemeralKey: ephemeralKey.secret,
    customer: customer.id,
  });
});

app.post('/payment-sheet-subscription', async (_, res) => {
  const { secret_key } = getKeys();

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  const customers = await stripe.customers.list();
  console.log({ customers });

  // Here, we're getting latest customer only for example purposes.
  const customer = customers.data[0];

  if (!customer) {
    return res.send({
      error: 'You have no customer created',
    });
  }

  console.log({ customer });

  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customer.id },
    { apiVersion: '2022-11-15' }
  );

  console.log({ ephemeralKey });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: 'price_1NaWhGKYtDf8GmtPsZJ5ztIE' }],
  });

  console.log({ subscription });

  if (typeof subscription.pending_setup_intent === 'string') {
    const setupIntent = await stripe.setupIntents.retrieve(
      subscription.pending_setup_intent
    );

    return res.json({
      setupIntent: setupIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
    });
  } else if (subscription.pending_setup_intent === null) {
    console.log('No setup intent');
    res.status(200).send();
  } else {
    throw new Error(
      'Expected response type string, but received: ' +
        typeof subscription.pending_setup_intent
    );
  }
});

app.post('/ephemeral-key', async (req, res) => {
  const { secret_key } = getKeys();

  const stripe = new Stripe(secret_key as string, {
    apiVersion: req.body.apiVersion,
    typescript: true,
  });

  try {
    let key = await stripe.ephemeralKeys.create(
      { issuing_card: req.body.issuingCardId },
      { apiVersion: req.body.apiVersion }
    );
    return res.send(key);
  } catch (e) {
    console.log(e);
    return res.send({ error: e });
  }
});

app.post('/issuing-card-details', async (req, res) => {
  const { secret_key } = getKeys();

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  try {
    let card = await stripe.issuing.cards.retrieve(req.body.id);

    if (!card) {
      console.log('No card with that ID exists.');
      return res.send({ error: 'No card with that ID exists.' });
    } else {
      return res.send(card);
    }
  } catch (e) {
    console.log(e);
    return res.send({ error: e });
  }
});

app.post('/financial-connections-sheet', async (_, res) => {
  const { secret_key } = getKeys();

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  const account = await stripe.accounts.create({
    country: 'US',
    type: 'custom',
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

  const session = await stripe.financialConnections.sessions.create({
    account_holder: { type: 'account', account: account.id },
    filters: { countries: ['US'] },
    permissions: ['ownership', 'payment_method'],
  });

  return res.send({ clientSecret: session.client_secret });
});

app.post('/payment-intent-for-payment-sheet', async (req, res) => {
  const { secret_key } = getKeys();

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 5099,
      currency: 'usd',
      payment_method: req.body.paymentMethodId,
      customer: req.body.customerId,
    });

    return res.send({ clientSecret: paymentIntent.client_secret });
  } catch (e) {
    return res.send({ error: e });
  }
});

app.post('/initialize-payment-sheet', async (req, res) => {
  const { secret_key } = getKeys();
  const { email, name, username, userid } = req.body;

  const oktaClient = new Okta.Client({
    orgUrl: 'https://dev-02732928.okta.com/',
    token: oktaApiToken, // Obtained from Developer Dashboard
  });

  let user = await oktaClient.userApi.getUser({
    userId: userid,
  });

  console.log('User: ', user);

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  // Create customer
  // TODO: Add Search Customer - stripe.customers.search({ query: username});

  const customer = await stripe.customers.create({
    email: username,
    name,
  });

  user = await oktaClient.userApi.updateUser({
    userId: userid,
    user: {
      profile: {
        stripeCustomerId: customer.id,
      },
    },
  });

  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customer.id },
    { apiVersion: '2022-11-15' }
  );

  console.log({ ephemeralKey });

  console.log('customerId', user.profile?.stripeCustomerId);
  res.send({
    ephemeralKey,
    customer: customer.id,
  });
});

app.post('/create-subscription', async (req, res) => {
  const { customerId } = req.body;
  const { secret_key } = getKeys();

  const priceId = 'price_1NaWhGKYtDf8GmtPsZJ5ztIE';

  const oktaClient = new Okta.Client({
    orgUrl: 'https://dev-02732928.okta.com/',
    token: oktaApiToken, // Obtained from Developer Dashboard
  });

  const stripe = new Stripe(secret_key as string, {
    apiVersion: '2022-11-15',
    typescript: true,
  });

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete', // This prevents crashing with no default-payment-method
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
  });

  res.send({
    subscriptionId: subscription.id,
    clientSecret: subscription.latest_invoice.payment_intent.client_secret,
  });
});

app.listen(4242, (): void =>
  console.log(`Node server listening on port ${4242}!`)
);
