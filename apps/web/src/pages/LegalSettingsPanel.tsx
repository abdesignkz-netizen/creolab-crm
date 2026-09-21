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
      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить реквизиты"));
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
      notifySaved("Реквизиты сохранены");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" id="company-requisites">
      <h3>Реквизиты компании</h3>
      <p className="muted">
        Реквизиты вашей организации. Они подставляются в договоры, счета, АВР и ЭСФ.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {!loaded ? (error ? <button className="btn secondary" onClick={()=>location.reload()}>Повторить загрузку</button> : <p role="status">Загружаем реквизиты…</p>) : !editing ? <>
      <dl className="deal-edit">
        {([
          ["Юридическое название", profile.legalName],
          ["БИН / ИИН", profile.bin || profile.iin],
          ["Юридический адрес", profile.legalAddress],
          ["Директор", profile.directorName],
          ["Телефон", profile.phone],
          ["Email", profile.email],
          ["Банк", profile.bankName],
          ["ИИК / IBAN", profile.iban],
          ["БИК", profile.bik],
          ...(CONTRACT_SIGNING_ENABLED
            ? [["Подписание ЭЦП", profile.contractSigningEnabled ? "Включено" : "Выключено"] as const]
            : []),
        ]).map(([label, value]) => <div key={label}><dt className="muted">{label}</dt><dd style={{margin:0}}>{value || "Не заполнено"}</dd></div>)}
      </dl>
      <div className="actions">
        <button type="button" className="btn secondary" autoFocus onClick={() => setEditing(true)}>Изменить реквизиты</button>
      </div>
      <InvoiceMarksEditor profile={profile} busy={busy} setBusy={setBusy} setError={setError} onUpdated={applyLoaded} />
      </> : <>
      <div className="deal-edit">
        <label>
          Юридическое название
          <input
            value={profile.legalName || ""}
            onChange={(e) => setProfile({ ...profile, legalName: e.target.value })}
          />
        </label>
        <label>
          БИН
          <input value={profile.bin || ""} onChange={(e) => setProfile({ ...profile, bin: e.target.value })} />
        </label>
        <label>ИИН (для ИП)<input value={profile.iin || ""} onChange={(e) => setProfile({ ...profile, iin: e.target.value })} /></label>
        <label>
          Юридический адрес
          <input
            value={profile.legalAddress || ""}
            onChange={(e) => setProfile({ ...profile, legalAddress: e.target.value })}
          />
        </label>
        <label>
          Банк
          <input value={profile.bankName || ""} onChange={(e) => setProfile({ ...profile, bankName: e.target.value })} />
        </label>
        <label>
          ИИК / IBAN
          <input value={profile.iban || ""} onChange={(e) => setProfile({ ...profile, iban: e.target.value })} />
        </label>
        <label>
          БИК
          <input value={profile.bik || ""} onChange={(e) => setProfile({ ...profile, bik: e.target.value })} />
        </label>
        <label>
          Директор
          <input
            value={profile.directorName || ""}
            onChange={(e) => setProfile({ ...profile, directorName: e.target.value })}
          />
        </label>
        <label>
          Телефон
          <input value={profile.phone || ""} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
        </label>
        <label>
          Email
          <input value={profile.email || ""} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
        </label>
        <label>
          Идентификатор ТРУ (G 18)
          <input
            value={profile.defaultCatalogTruId || ""}
            onChange={(e) => setProfile({ ...profile, defaultCatalogTruId: e.target.value })}
            placeholder="Из справочника ИС ЭСФ, не выдумывать"
          />
        </label>
        <label>
          НДС по умолчанию
          <select value={vatChoice} onChange={(e) => setVatChoice(e.target.value as typeof vatChoice)}>
            <option value="unset">Не выбрано — не подставлять автоматически</option>
            <option value="none">Без НДС</option>
            <option value="12">12%</option>
            <option value="custom">Своя ставка</option>
          </select>
        </label>
        {vatChoice === "custom" ? (
          <label>
            Ставка, %
            <input value={customRate} onChange={(e) => setCustomRate(e.target.value)} />
          </label>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={profile.documentsEnabled}
            onChange={(e) => setProfile({ ...profile, documentsEnabled: e.target.checked })}
          />{" "}
          Черновики договора, счёта, АВР и ЭСФ. Раздел «Документы» в меню
        </label>
        {CONTRACT_SIGNING_ENABLED ? (
        <label>
          <input
            type="checkbox"
            checked={profile.contractSigningEnabled}
            onChange={(e) => setProfile({ ...profile, contractSigningEnabled: e.target.checked })}
          />{" "}
          Подписание договора ЭЦП (NCALayer)
        </label>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={profile.esfIntegrationEnabled}
            onChange={(e) => setProfile({ ...profile, esfIntegrationEnabled: e.target.checked })}
          />{" "}
          Контур ИС ЭСФ включён. Подключение кабинета — в{" "}
          <Link to="/integrations/esf">Интеграции → ИС ЭСФ</Link>, не путь к ЭЦП и не PIN.
        </label>
        {preflight ? (
          <div className={preflight.ready ? "banner" : "banner warn"} style={{ marginTop: 12 }}>
            <b>{preflight.ready ? "ИС ЭСФ готов к отправке" : "ИС ЭСФ ещё не готов"}</b>
            <p className="muted">
              {preflight.ready
                ? "Кабинет подключается в Интеграции → ИС ЭСФ через NCALayer."
                : "Отправка в ИС ЭСФ пока недоступна. Если кабинет уже должен работать — обратитесь в поддержку."}
            </p>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void loadPreflight()}>
              Проверить снова
            </button>
          </div>
        ) : null}
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? "Сохраняем…" : "Сохранить реквизиты"}
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
  async function upload(kind: "stamp" | "signature", file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      const next = (await api.uploadLegalMark(kind, { contentBase64, mimeType: file.type || "image/png" })) as Profile;
      onUpdated(next);
      notifySaved(kind === "stamp" ? "Печать сохранена" : "Подпись сохранена");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить файл");
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
      setError(err instanceof Error ? err.message : "Не удалось удалить файл");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="invoice-marks" style={{ marginTop: 16 }}>
      <h4>Печать и подпись на счёте</h4>
      <p className="muted">PNG или JPEG. Используются, когда в просмотре счёта выбран вариант «С подписью и печатью».</p>
      <div className="invoice-marks-grid">
        {(
          [
            ["stamp", "Печать", profile.hasStamp],
            ["signature", "Подпись", profile.hasSignature],
          ] as const
        ).map(([kind, label, ready]) => (
          <label key={kind}>
            {label}
            {ready ? <img src={`${api.legalMarkUrl(kind)}?t=${Number(Boolean(profile.hasStamp))}${Number(Boolean(profile.hasSignature))}`} alt={label} /> : <span className="muted">Не загружена</span>}
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
                Удалить
              </button>
            ) : null}
          </label>
        ))}
      </div>
    </div>
  );
}
