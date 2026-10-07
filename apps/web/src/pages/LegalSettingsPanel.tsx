import { InlineFeedback } from "../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../lib/uiText";
import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";

type Profile = {
  legalName: string | null;
  bin: string | null;
  iin: string | null;
  legalAddress: string | null;
  iban: string | null;
  bankName: string | null;
  bik: string | null;
  directorName: string | null;
  directorPosition: string | null;
  phone: string | null;
  email: string | null;
  defaultVatMode: "none" | "percent" | null;
  defaultVatRate: number | null;
  documentsEnabled: boolean;
  contractSigningEnabled: boolean;
  esfIntegrationEnabled: boolean;
  defaultCatalogTruId: string | null;
  vatConfigured: boolean;
  hasStamp?: boolean;
  hasSignature?: boolean;
};

const EMPTY: Profile = {
  legalName: "",
  bin: "",
  iin: "",
  legalAddress: "",
  iban: "",
  bankName: "",
  bik: "",
  directorName: "",
  directorPosition: "",
  phone: "",
  email: "",
  defaultVatMode: null,
  defaultVatRate: null,
  documentsEnabled: true,
  contractSigningEnabled: false,
  esfIntegrationEnabled: false,
  defaultCatalogTruId: "",
  vatConfigured: false,
  hasStamp: false,
  hasSignature: false,
};

export function LegalSettingsPanel() {
  const uiText = useUiText();
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [vatChoice, setVatChoice] = useState<"unset" | "none" | "12" | "custom">("unset");
  const [customRate, setCustomRate] = useState("12");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [preflight, setPreflight] = useState<any>(null);

  function applyLoaded(data: Profile) {
    setProfile({ ...EMPTY, ...data });
    if (!data.defaultVatMode) {
      setVatChoice("unset");
    } else if (data.defaultVatMode === "none") {
      setVatChoice("none");
    } else if (Number(data.defaultVatRate) === 12) {
      setVatChoice("12");
    } else {
      setVatChoice("custom");
      setCustomRate(String(data.defaultVatRate ?? ""));
    }
  }

  async function loadPreflight() {
    try {
      setPreflight(await api.esfPreflight());
    } catch {
      setPreflight(null);
    }
  }

  useEffect(() => {
    void api
      .legalProfile()
      .then((data) => {
        applyLoaded(data as Profile);
        setEditing(!(data as Profile).legalName);
        setLoaded(true);
        if (location.hash === "#company-requisites") document.getElementById("company-requisites")?.scrollIntoView();
      })
      .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось загрузить реквизиты")));
    void loadPreflight();
  }, []);

  async function save() {
    if (busy || !loaded) return;
    setBusy(true);
    setError("");
    try {
      const defaultVatMode = vatChoice === "unset" ? null : vatChoice === "none" ? "none" : "percent";
      const defaultVatRate =
        vatChoice === "12" ? 12 : vatChoice === "custom" ? Number(String(customRate).replace(",", ".")) : vatChoice === "none" ? 0 : null;
      const next = (await api.updateLegalProfile({
        legalName: profile.legalName || null,
        bin: profile.bin || null,
        iin: profile.iin || null,
        legalAddress: profile.legalAddress || null,
        iban: profile.iban || null,
        bankName: profile.bankName || null,
        bik: profile.bik || null,
        directorName: profile.directorName || null,
        phone: profile.phone || null,
        email: profile.email || null,
        defaultVatMode,
        defaultVatRate,
        documentsEnabled: profile.documentsEnabled,
        contractSigningEnabled: profile.contractSigningEnabled,
        esfIntegrationEnabled: profile.esfIntegrationEnabled,
        defaultCatalogTruId: profile.defaultCatalogTruId || null,
      })) as Profile;
      applyLoaded(next);
      setEditing(false);
      notifySaved(uiText("Реквизиты сохранены"));
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" id="company-requisites">
      <h3>{uiText("Реквизиты компании")}</h3>
      <p className="muted">
        {uiText("Реквизиты вашей организации. Они подставляются в договоры, счета, АВР и ЭСФ.")}</p>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {!loaded ? (error ? <button className="btn secondary" onClick={()=>location.reload()}>{uiText("Повторить загрузку")}</button> : <p role="status">{uiText("Загружаем реквизиты…")}</p>) : !editing ? <>
      <dl className="deal-edit">
        {([
          [uiText("Юридическое название"), profile.legalName],
          [uiText("БИН / ИИН"), profile.bin || profile.iin],
          [uiText("Юридический адрес"), profile.legalAddress],
          [uiText("Директор"), profile.directorName],
          [uiText("Телефон"), profile.phone],
          ["Email", profile.email],
          [uiText("Банк"), profile.bankName],
          [uiText("ИИК / IBAN"), profile.iban],
          [uiText("БИК"), profile.bik],
          ...(CONTRACT_SIGNING_ENABLED
            ? [[uiText("Подписание ЭЦП"), profile.contractSigningEnabled ? uiText("Включено") : uiText("Выключено")] as const]
            : []),
        ]).map(([label, value]) => <div key={label}><dt className="muted">{label}</dt><dd style={{margin:0}}>{value || uiText("Не заполнено")}</dd></div>)}
      </dl>
      <div className="actions">
        <button type="button" className="btn secondary" autoFocus onClick={() => setEditing(true)}>{uiText("Изменить реквизиты")}</button>
      </div>
      <InvoiceMarksEditor profile={profile} busy={busy} setBusy={setBusy} setError={setError} onUpdated={applyLoaded} />
      </> : <>
      <div className="deal-edit">
        <label>
          {uiText("Юридическое название")}<input
            value={profile.legalName || ""}
            onChange={(e) => setProfile({ ...profile, legalName: e.target.value })}
          />
        </label>
        <label>
          {uiText("БИН")}<input value={profile.bin || ""} onChange={(e) => setProfile({ ...profile, bin: e.target.value })} />
        </label>
        <label>{uiText("ИИН (для ИП)")}<input value={profile.iin || ""} onChange={(e) => setProfile({ ...profile, iin: e.target.value })} /></label>
        <label>
          {uiText("Юридический адрес")}<input
            value={profile.legalAddress || ""}
            onChange={(e) => setProfile({ ...profile, legalAddress: e.target.value })}
          />
        </label>
        <label>
          {uiText("Банк")}<input value={profile.bankName || ""} onChange={(e) => setProfile({ ...profile, bankName: e.target.value })} />
        </label>
        <label>
          {uiText("ИИК / IBAN")}<input value={profile.iban || ""} onChange={(e) => setProfile({ ...profile, iban: e.target.value })} />
        </label>
        <label>
          {uiText("БИК")}<input value={profile.bik || ""} onChange={(e) => setProfile({ ...profile, bik: e.target.value })} />
        </label>
        <label>
          {uiText("Директор")}<input
            value={profile.directorName || ""}
            onChange={(e) => setProfile({ ...profile, directorName: e.target.value })}
          />
        </label>
        <label>
          {uiText("Телефон")}<input value={profile.phone || ""} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
        </label>
        <label>
          Email
          <input value={profile.email || ""} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
        </label>
        <label>
          {uiText("Идентификатор ТРУ (G 18)")}<input
            value={profile.defaultCatalogTruId || ""}
            onChange={(e) => setProfile({ ...profile, defaultCatalogTruId: e.target.value })}
            placeholder={uiText("Из справочника ИС ЭСФ, не выдумывать")}
          />
        </label>
        <label>
          {uiText("НДС по умолчанию")}<select value={vatChoice} onChange={(e) => setVatChoice(e.target.value as typeof vatChoice)}>
            <option value="unset">{uiText("Не выбрано — не подставлять автоматически")}</option>
            <option value="none">{uiText("Без НДС")}</option>
            <option value="12">12%</option>
            <option value="custom">{uiText("Своя ставка")}</option>
          </select>
        </label>
        {vatChoice === "custom" ? (
          <label>
            {uiText("Ставка, %")}<input value={customRate} onChange={(e) => setCustomRate(e.target.value)} />
          </label>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={profile.documentsEnabled}
            onChange={(e) => setProfile({ ...profile, documentsEnabled: e.target.checked })}
          />{" "}
          {uiText("Черновики договора, счёта, АВР и ЭСФ. Раздел «Документы» в меню")}</label>
        {CONTRACT_SIGNING_ENABLED ? (
        <label>
          <input
            type="checkbox"
            checked={profile.contractSigningEnabled}
            onChange={(e) => setProfile({ ...profile, contractSigningEnabled: e.target.checked })}
          />{" "}
          {uiText("Подписание договора ЭЦП (NCALayer)")}</label>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={profile.esfIntegrationEnabled}
            onChange={(e) => setProfile({ ...profile, esfIntegrationEnabled: e.target.checked })}
          />{" "}
          {uiText("Контур ИС ЭСФ включён. Подключение кабинета — в")}{" "}
          <Link to="/integrations/esf">{uiText("Интеграции → ИС ЭСФ")}</Link>{uiText(", не путь к ЭЦП и не PIN.")}</label>
        {preflight ? (
          <div className={preflight.ready ? "banner" : "banner warn"} style={{ marginTop: 12 }}>
            <b>{preflight.ready ? uiText("ИС ЭСФ готов к отправке") : uiText("ИС ЭСФ ещё не готов")}</b>
            <p className="muted">
              {preflight.ready
                ? uiText("Кабинет подключается в Интеграции → ИС ЭСФ через NCALayer.")
                : uiText("Отправка в ИС ЭСФ пока недоступна. Если кабинет уже должен работать — обратитесь в поддержку.")}
            </p>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void loadPreflight()}>
              {uiText("Проверить снова")}</button>
          </div>
        ) : null}
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? uiText("Сохраняем…") : uiText("Сохранить реквизиты")}
        </button>
      </div>
      <InvoiceMarksEditor profile={profile} busy={busy} setBusy={setBusy} setError={setError} onUpdated={applyLoaded} />
      </>}
    </div>
  );
}

function InvoiceMarksEditor({
  profile,
  busy,
  setBusy,
  setError,
  onUpdated,
}: {
  profile: Profile;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setError: (v: string) => void;
  onUpdated: (data: Profile) => void;
}) {
  const uiText = useUiText();
  async function upload(kind: "stamp" | "signature", file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(uiText("Не удалось прочитать файл")));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      const next = (await api.uploadLegalMark(kind, { contentBase64, mimeType: file.type || "image/png" })) as Profile;
      onUpdated(next);
      notifySaved(kind === "stamp" ? uiText("Печать сохранена") : uiText("Подпись сохранена"));
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось загрузить файл"));
    } finally {
      setBusy(false);
    }
  }
  async function remove(kind: "stamp" | "signature") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onUpdated((await api.deleteLegalMark(kind)) as Profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось удалить файл"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="invoice-marks" style={{ marginTop: 16 }}>
      <h4>{uiText("Печать и подпись на счёте")}</h4>
      <p className="muted">{uiText("PNG или JPEG. Используются, когда в просмотре счёта выбран вариант «С подписью и печатью».")}</p>
      <div className="invoice-marks-grid">
        {(
          [
            ["stamp", uiText("Печать"), profile.hasStamp],
            ["signature", uiText("Подпись"), profile.hasSignature],
          ] as const
        ).map(([kind, label, ready]) => (
          <label key={kind}>
            {label}
            {ready ? <img src={`${api.legalMarkUrl(kind)}?t=${Number(Boolean(profile.hasStamp))}${Number(Boolean(profile.hasSignature))}`} alt={label} /> : <span className="muted">{uiText("Не загружена")}</span>}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void upload(kind, file);
              }}
            />
            {ready ? (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void remove(kind)}>
                {uiText("Удалить")}</button>
            ) : null}
          </label>
        ))}
      </div>
    </div>
  );
}
