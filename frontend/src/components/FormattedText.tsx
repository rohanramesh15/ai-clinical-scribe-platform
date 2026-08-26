// Renders **bold** markers as real <strong> text; everything else passes
// through unchanged. Not a general markdown parser — this app's notes are
// plain text by design (see the "no Markdown" instruction in
// backend/app/llm.py) — this only exists so bold survives in read-only note
// views if it's ever present (a manual edit, pasted content, etc.). Not used
// in editable/streaming views: an HTML textarea can't render inline bold,
// so applying this there would make formatting visibly vanish the moment a
// note becomes editable.
export function FormattedText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      )}
    </>
  );
}
