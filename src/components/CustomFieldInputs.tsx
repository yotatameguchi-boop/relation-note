import type { FieldDef } from "@/lib/customFields";

/** 追加項目の入力欄（cf:<key> の名前で送る） */
export function CustomFieldInputs({ defs, values }: { defs: FieldDef[]; values: Record<string, unknown> }) {
  const active = defs.filter((d) => !d.archived);
  if (!active.length) return null;
  return (
    <>
      {active.map((d) => {
        const name = `cf:${d.key}`;
        const v = values?.[d.key];
        const label = <>{d.label}{d.required && " *"}</>;
        switch (d.field_type) {
          case "long_text":
            return <label key={d.key} className="field">{label}<textarea name={name} defaultValue={(v as string) ?? ""} /></label>;
          case "select":
            return (
              <label key={d.key} className="field">{label}
                <select name={name} defaultValue={(v as string) ?? ""}>
                  <option value="">（未選択）</option>
                  {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            );
          case "multi_select":
            return (
              <fieldset key={d.key} className="field" style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
                <legend className="small muted" style={{ marginBottom: 4 }}>{label}</legend>
                <input type="hidden" name={`${name}:present`} value="1" />
                <div className="row">{d.options.map((o) => (
                  <label key={o} className="tag" style={{ margin: 0 }}>
                    <input type="checkbox" name={name} value={o} defaultChecked={Array.isArray(v) && v.includes(o)} />{o}
                  </label>
                ))}</div>
              </fieldset>
            );
          case "checkbox":
            return (
              <label key={d.key} className="row field" style={{ color: "var(--text)" }}>
                <input type="hidden" name={`${name}:present`} value="1" />
                <input type="checkbox" name={name} defaultChecked={v === true} />{label}
              </label>
            );
          default: {
            const type = d.field_type === "number" ? "text" : d.field_type === "phone" ? "tel" : d.field_type === "text" ? "text" : d.field_type;
            return (
              <label key={d.key} className="field">{label}
                <input name={name} type={type} inputMode={d.field_type === "number" ? "decimal" : undefined} defaultValue={v == null ? "" : String(v)} />
              </label>
            );
          }
        }
      })}
    </>
  );
}
