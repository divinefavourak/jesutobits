import { Button } from "./Button";

export function Hero() {
  return (
    <section className="py-24 text-center">
      <img src="/logo.svg" alt="" className="mx-auto mb-6 h-12 w-12" />
      <h1 className="text-4xl font-bold">Track habits</h1>
      <p className="mt-4 text-lg text-slate-600">
        Small steps, <strong className="text-indigo-600">every day</strong>.
      </p>
      <div className="mt-8 flex justify-center gap-4">
        <Button>Get started</Button>
        <a href="#features" className="px-4 py-2 text-indigo-600">
          Learn more
        </a>
      </div>
    </section>
  );
}
