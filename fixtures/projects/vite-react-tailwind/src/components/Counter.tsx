import { useState } from "react";
import { Button } from "./Button";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div className="my-12 flex items-center gap-4" data-testid="counter">
      <span className="text-2xl tabular-nums" data-testid="count">
        {count}
      </span>
      <Button onClick={() => setCount((c) => c + 1)}>Add one</Button>
    </div>
  );
}
