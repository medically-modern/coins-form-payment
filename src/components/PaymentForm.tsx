import { useState, useEffect } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";

const API_URL =
  import.meta.env.VITE_API_URL ||
  "https://coins-form-payment-production.up.railway.app";

// ─── Inner checkout form (inside Elements provider) ───
function CheckoutForm({ amount, onSuccess }: { amount: number; onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message || "Please check your card details.");
      setProcessing(false);
      return;
    }

    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href,
      },
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message || "Payment failed. Please try again.");
      setProcessing(false);
    } else {
      setSucceeded(true);
      setProcessing(false);
      onSuccess();
    }
  };

  if (succeeded) {
    return (
      <div className="text-center py-6 space-y-2">
        <div className="text-2xl text-green-600">&#10003;</div>
        <p className="text-lg font-semibold text-foreground">Payment Successful</p>
        <p className="text-sm text-muted-foreground">
          Your payment of ${amount.toFixed(2)} has been processed. Thank you!
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}
      <button
        type="submit"
        disabled={!stripe || processing}
        className="w-full rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {processing ? "Processing..." : `Pay $${amount.toFixed(2)}`}
      </button>
    </form>
  );
}

// ─── Outer wrapper: loads Stripe, creates PaymentIntent ───
export function PaymentForm({
  jwt,
  amount,
}: {
  jwt: string;
  amount: number;
}) {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    // 1. Get publishable key
    fetch(`${API_URL}/api/stripe-config`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.publishableKey) {
          setStripePromise(loadStripe(data.publishableKey));
        } else {
          setError("Payment system not configured.");
        }
      })
      .catch(() => setError("Unable to load payment system."));

    // 2. Create PaymentIntent
    fetch(`${API_URL}/api/create-payment-intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ amount }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.clientSecret) {
          setClientSecret(data.clientSecret);
        } else {
          setError(data.error || "Unable to initiate payment.");
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Unable to connect to payment server.");
        setLoading(false);
      });
  }, [jwt, amount]);

  if (paid) {
    return (
      <div className="text-center py-6 space-y-2">
        <div className="text-2xl text-green-600">&#10003;</div>
        <p className="text-lg font-semibold text-foreground">Payment Successful</p>
        <p className="text-sm text-muted-foreground">
          Your payment of ${amount.toFixed(2)} has been processed. Thank you!
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        <span className="ml-2 text-sm text-muted-foreground">Loading payment form...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 border border-red-200 p-4">
        <p className="text-sm text-red-700">{error}</p>
      </div>
    );
  }

  if (!stripePromise || !clientSecret) return null;

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#0f172a",
            borderRadius: "6px",
          },
        },
      }}
    >
      <CheckoutForm amount={amount} onSuccess={() => setPaid(true)} />
    </Elements>
  );
}
