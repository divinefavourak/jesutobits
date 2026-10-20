import { Counter } from "./components/Counter";
import { FeatureList } from "./components/FeatureList";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";

export function App() {
  return (
    <main className="mx-auto max-w-3xl p-8 font-sans text-slate-900">
      <Hero />
      <FeatureList />
      <Counter />
      <Footer />
    </main>
  );
}
