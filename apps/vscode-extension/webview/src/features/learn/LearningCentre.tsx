import { useEffect, useId, useRef, useState } from "react";
import { t, type MessageKey } from "../../i18n";
import { useWorkbench } from "../../state/workbench-context";
import { Glyph } from "../../ui/Studio";

interface Lesson {
  id: "basics" | "component" | "styling" | "ai";
  minutes: number;
  /** A file of the user's project the lesson points at, relative to the project. */
  file?: string;
  answer: 0 | 1;
}

const LESSONS: readonly Lesson[] = [
  { id: "basics", minutes: 3, file: "package.json", answer: 0 },
  { id: "component", minutes: 5, file: "src/App.tsx", answer: 0 },
  { id: "styling", minutes: 4, file: "src/index.css", answer: 1 },
  { id: "ai", minutes: 3, answer: 0 },
];

/** Badge colours per lesson, from theme tokens. */
const BADGES = [
  "bg-accent-subtle text-accent",
  "bg-success-subtle text-success",
  "bg-warning-subtle text-warning",
  "bg-info-subtle text-info",
];

/** `ui-state` key: the lessons whose check the user answered correctly. */
const UI_KEY = "learningCompleted";

const text = (lesson: Lesson, part: string) => t(`learn.${lesson.id}.${part}` as MessageKey);

/**
 * The Learning Centre (Figma Make "Jesutobits AI Coding Workspace", LearningCentre.tsx):
 * bite-sized lessons with a quick check. Explore opens the matching file of the user's own
 * project; Ask puts a question in the agent's message box for the user to send.
 */
export function LearningCentre({ onAsk }: { onAsk: (text: string) => void }) {
  const { bridge } = useWorkbench();
  const [open, setOpen] = useState<number | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [completed, setCompleted] = useState<string[]>([]);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const checkId = useId();

  useEffect(() => {
    void bridge.uiState
      .get()
      .then((state) => {
        const saved = state[UI_KEY];
        if (Array.isArray(saved)) setCompleted(saved.filter((id) => typeof id === "string"));
      })
      .catch(() => undefined);
  }, [bridge]);

  useEffect(() => heading.current?.focus(), [open]);

  const show = (index: number | null) => {
    setOpen(index);
    setChoice(null);
    setFileNote(null);
  };

  const answer = (lesson: Lesson, picked: number) => {
    setChoice(picked);
    if (picked !== lesson.answer || completed.includes(lesson.id)) return;
    const next = [...completed, lesson.id];
    setCompleted(next);
    void bridge.uiState.update({ [UI_KEY]: next }).catch(() => undefined);
  };

  const explore = async (file: string) => {
    setFileNote(null);
    try {
      await bridge.openFile(file);
    } catch {
      setFileNote(t("learn.missingFile", { file }));
    }
  };

  const lesson = open === null ? null : LESSONS[open];

  return (
    <section aria-label={t("agent.tab.learn")} className="studio-in flex flex-col gap-4 p-4">
      <div>
        <p className="m-0 mb-1 text-xs tracking-widest text-text-muted">{t("learn.eyebrow")}</p>
        <h2
          ref={heading}
          tabIndex={-1}
          className="m-0 mb-2 font-display text-xl leading-snug font-medium outline-none"
        >
          {lesson ? t("learn.titleLesson") : t("learn.title")}
        </h2>
        <p className="m-0 mb-2 leading-relaxed text-text-muted">{t("learn.body")}</p>
        <p className="m-0 text-xs text-text-muted">
          {t("learn.count", { done: completed.length, total: LESSONS.length })}
        </p>
      </div>

      {lesson ? (
        <article className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => show(null)}
            className="self-start text-text-muted hover:text-text"
          >
            ← {t("learn.back")}
          </button>
          <p className="m-0 text-xs text-text-muted">
            {t("learn.minutes", { category: text(lesson, "category"), minutes: lesson.minutes })}
          </p>
          <h3 className="m-0 font-display text-lg leading-snug font-medium">
            {text(lesson, "heading")}
          </h3>
          <p className="m-0 leading-relaxed">{text(lesson, "body")}</p>
          <pre className="m-0 overflow-x-auto rounded-lg bg-surface-sunken p-3 font-mono text-xs">
            {text(lesson, "code")}
          </pre>
          <div
            role="group"
            aria-labelledby={checkId}
            className="rounded-lg border border-border bg-surface-raised p-3"
          >
            <p id={checkId} className="m-0 mb-1 font-medium">
              {t("learn.check")}
            </p>
            <p className="m-0 mb-2">{text(lesson, "question")}</p>
            <div className="flex flex-wrap gap-2">
              {[0, 1].map((index) => (
                <button
                  key={index}
                  type="button"
                  aria-pressed={choice === index}
                  onClick={() => answer(lesson, index)}
                  className={`rounded-full border px-3 py-1 ${choice === index ? "border-accent bg-accent-subtle text-text" : "border-border-strong text-text-muted hover:text-text"}`}
                >
                  {text(lesson, `choice${index}`)}
                </button>
              ))}
            </div>
            {choice !== null && (
              <p
                role="status"
                className={`m-0 mt-2 ${choice === lesson.answer ? "text-success" : "text-text-muted"}`}
              >
                {choice === lesson.answer ? t("learn.right") : t("learn.wrong")}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {lesson.file && (
              <button
                type="button"
                onClick={() => void explore(lesson.file!)}
                className="flex items-center gap-1.5 self-start text-accent hover:underline"
              >
                <Glyph name="code" size={14} />
                {t("learn.explore", { file: lesson.file })}
              </button>
            )}
            {fileNote && (
              <p role="status" className="m-0 text-text-muted">
                {fileNote}
              </p>
            )}
            <button
              type="button"
              onClick={() =>
                onAsk(t("learn.askPrompt", { topic: text(lesson, "title").toLowerCase() }))
              }
              className="flex items-center gap-1.5 self-start text-accent hover:underline"
            >
              <Glyph name="chat" size={14} />
              {t("learn.ask")}
            </button>
          </div>
        </article>
      ) : (
        <>
          <div className="flex flex-col gap-2 rounded-lg border border-accent-subtle bg-accent-subtle p-3">
            <p className="m-0 text-xs tracking-widest text-text-muted">
              {t("learn.featureEyebrow")}
            </p>
            <p className="m-0 font-display text-base font-medium">{t("learn.featureTitle")}</p>
            <p className="m-0 text-text-muted">{t("learn.featureBody")}</p>
            <button
              type="button"
              onClick={() => show(0)}
              className="flex items-center gap-1.5 self-start rounded-md bg-accent px-3 py-1.5 font-medium text-text-on-accent hover:bg-accent-hover"
            >
              {t("learn.begin")}
              <Glyph name="arrow" size={14} />
            </button>
          </div>
          <ul className="m-0 grid list-none gap-3 p-0">
            {LESSONS.map((item, index) => {
              const done = completed.includes(item.id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => show(index)}
                    className="flex w-full flex-col gap-1 rounded-lg border border-border bg-surface-raised p-3 text-left hover:-translate-y-0.5 hover:border-accent motion-reduce:hover:translate-y-0"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold ${BADGES[index]}`}
                        aria-hidden="true"
                      >
                        {done ? <Glyph name="check" size={14} /> : `0${index + 1}`}
                      </span>
                      <span className="text-xs text-text-muted">
                        {t("learn.minutes", {
                          category: text(item, "category"),
                          minutes: item.minutes,
                        })}
                      </span>
                    </span>
                    <span className="font-display font-medium">{text(item, "title")}</span>
                    <span className="text-text-muted">{text(item, "description")}</span>
                    <span className="flex items-center gap-1 text-accent">
                      {done ? t("learn.revisit") : t("learn.open")}
                      <Glyph name="arrow" size={13} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="m-0 text-center text-xs text-text-muted">{t("learn.note")}</p>
        </>
      )}
    </section>
  );
}
