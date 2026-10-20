import { cn } from "../cn";

const features = [
  { title: "Streaks", body: "See how many days in a row you kept a habit.", highlight: true },
  { title: "Reminders", body: "Get a nudge at the time you choose.", highlight: false },
  { title: "Insights", body: "Weekly charts of what worked.", highlight: false },
];

export const FeatureList = () => (
  <section id="features" className="grid gap-4 sm:grid-cols-3">
    {features.map((feature) => (
      <article
        key={feature.title}
        className={cn("rounded-xl border p-4", feature.highlight && "border-indigo-600")}
      >
        <h2 className="text-lg font-semibold">{feature.title}</h2>
        <p className="text-sm text-slate-600">{feature.body}</p>
        {feature.highlight && <status-badge class="text-xs text-indigo-600">Popular</status-badge>}
      </article>
    ))}
  </section>
);
