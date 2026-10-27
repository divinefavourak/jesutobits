// "New project" (Studio design: "Every great thing starts somewhere."): the folder name a
// project's name becomes. Pure, so the rules are tested without VS Code.

/** Characters Windows does not allow in a file name (control characters are checked apart). */
const FORBIDDEN = /[<>:"/\\|?*]/;
const hasControl = (text: string) => [...text].some((char) => char.charCodeAt(0) < 32);
/** Names Windows reserves, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why a project name cannot be a folder name, or null when it can. */
export function projectNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give your project a name.";
  if (trimmed.length > 80) return "Keep the name under 80 characters.";
  if (FORBIDDEN.test(trimmed) || hasControl(trimmed))
    return 'A name cannot contain < > : " / \\ | ? or *.';
  if (RESERVED.test(trimmed)) return "Windows keeps that name for itself. Try another.";
  if (/[. ]$/.test(trimmed)) return "A name cannot end with a dot or a space.";
  return null;
}

/** The project's folder name: the trimmed name, with runs of spaces made single. */
export function projectFolderName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}
