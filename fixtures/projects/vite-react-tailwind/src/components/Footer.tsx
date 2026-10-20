export const Footer = () => {
  const year = 2026;
  return (
    <>
      <hr className="my-8 border-slate-200" />
      <footer className="text-sm text-slate-500">
        <span>© {year} Habit tracker</span>
        <ul className="mt-2 flex gap-4">
          <li><a href="#privacy">Privacy</a></li>
          <li><a href="#terms">Terms</a></li>
        </ul>
      </footer>
    </>
  );
};
