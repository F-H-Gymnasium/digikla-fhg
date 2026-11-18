const firebaseConfig = {
  apiKey: "AIzaSyAwCqACtAT0WQz9yvnE604n8P_hFodRQjA",
  authDomain: "digikla-fhg.firebaseapp.com",
  projectId: "digikla-fhg",
  storageBucket: "digikla-fhg.firebasestorage.app",
  messagingSenderId: "325888030036",
  appId: "1:325888030036:web:b78cc359b0a86cec0044c1",
  measurementId: "G-3E0E7EJ6E2"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ==========================================================================
// HILFSFUNKTIONEN & ZUSTAND
// ==========================================================================
const $ = id => document.getElementById(id);
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const heute = () => new Date().toLocaleDateString("sv-SE");
const TAGE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const datumDE = d => d.split("-").reverse().join(".");

// Abwesenheits-Status -> Farbe (u = rot, g = gelb, e = grün); alte Status werden übersetzt
const FARBE = { Unentschuldigt: "u", Gemeldet: "g", Entschuldigt: "e" };
const LEGACY = { Unentschuldigt: "Unentschuldigt", Verspätet: "Gemeldet", Entschuldigt: "Entschuldigt", Freigestellt: "Entschuldigt" };
const deckt = (a, d, std) => a.von <= d && d <= a.bis && (a.art !== "Stunden" || (a.stunden || []).includes(std));
const abwBereich = e => e.art === "Zeitraum" ? `${datumDE(e.von)} - ${datumDE(e.bis)}` : e.art === "Stunden" ? `${datumDE(e.von)}, Std. ${(e.stunden || []).join(", ")}` : datumDE(e.von);

// Wer fehlt in dieser Stunde? Abwesenheits-Einträge überschreiben den Kippschalter der Lehrkraft.
function abwesende(k, d, std, x, abw) {
    const res = new Map();
    Object.entries(x.anwesenheit || {}).forEach(([n, st]) => {
        if (st !== "Anwesend") res.set(n, { name: n, status: LEGACY[st] || "Unentschuldigt", grund: st === "Unentschuldigt" ? "" : st });
    });
    abw.filter(a => a.klasse === k && deckt(a, d, std)).forEach(a =>
        res.set(a.schueler, { name: a.schueler, status: a.status, grund: a.grund, id: a.id, art: a.art, von: a.von, bis: a.bis, stunden: a.stunden, notiz: a.notiz }));
    return [...res.values()];
}
const VIEWS = ["dashboardView", "klassenbuchView", "abwesenheitenView", "detailView", "notenView", "stundenplanEditorView", "adminPanelView"];
const STATUS = [["Anwesend", "Anwesend"], ["Unentschuldigt", "Unentschuldigt fehlt"], ["Verspätet", "Verspätet"], ["Entschuldigt", "Entschuldigt"], ["Freigestellt", "Freigestellt"]];

let rolle = "Lehrer", uid = null, profil = null, stdNr = null;
let plan = [], schueler = [], zeiten = [], lehrer = {}, cfg = { text: "", start: "", end: "" };
let ansicht = "dashboardView", dashZaehler = 0, notenCtx = {}, aktLeiter = "", gruende = [], abwFarbe = "Unentschuldigt", abwBearbeiten = null, klasseAbw = [], klassenLeiter = {}, alarmStop = null, bekannt = new Set(), audioCtx = null;

const klasse = () => $("klassenAuswahl").value;
const datum = () => $("aktuellesDatum").value;
const keyOf = (k, d, s) => `${k}_${d}_Std${s}`;
const stdRef = s => db.collection("klassenbuch").doc(keyOf(klasse(), datum(), s));
const planRef = (k, id) => db.collection("klassen").doc(k).collection("stundenplaene").doc(id);
const anzahlStunden = () => Math.max(zeiten.length, 6);

function showView(id) {
    ansicht = id;
    $("tabArbeit").classList.toggle("on", id === "dashboardView");
    $("tabAbw").classList.toggle("on", id === "abwesenheitenView");
    VIEWS.forEach(v => $(v).style.display = v === id ? "block" : "none");
}

// Wochentag, Kalenderwoche und A/B-Woche (Mittagszeit vermeidet Zeitzonen-Fehler)
function wochenInfo(ds) {
    const d = new Date(ds + "T12:00:00"), tag = d.getDay();
    d.setDate(d.getDate() + 4 - (tag || 7));
    const kw = Math.ceil((((d - new Date(d.getFullYear(), 0, 1)) / 864e5) + 1) / 7);
    const typ = kw % 2 ? "A" : "B";
    return { tag, kw, typ, id: `${tag}_${typ}`, werktag: tag >= 1 && tag <= 5 };
}

// ==========================================================================
// LOGIN
// ==========================================================================
function login() {
    auth.signInWithEmailAndPassword($("loginEmail").value.trim(), $("loginPassword").value)
        .catch(() => { $("loginError").innerText = "E-Mail oder Passwort stimmt nicht."; });
}
function logout() { auth.signOut(); }
$("loginPassword").addEventListener("keydown", e => e.key === "Enter" && login());

auth.onAuthStateChanged(async user => {
    $("loginView").style.display = user ? "none" : "block";
    $("appView").style.display = user ? "block" : "none";
    if (!user) { if (alarmStop) alarmStop(); alarmStop = null; $("sekBanner").style.display = "none"; return; }
    uid = user.uid;
    try {
        const u = await db.collection("users").doc(uid).get();
        rolle = u.exists ? (u.data().rolle || "Lehrer") : "Lehrer";
        await Promise.all([ladeEinstellungen(), ladeLehrer()]);
        profil = lehrer[uid] || (rolle === "Sekretariat" ? { name: u.data().name || "Sekretariat", kuerzel: "" } : null);
        if (!profil) throw new Error("kein Profil");
    } catch (e) {
        $("loginError").innerText = `Kein Zugriff: Für dein Konto gibt es kein Lehrerprofil. Deine UID: ${uid}`;
        return auth.signOut();
    }
    $("angemeldeterUser").innerText = `${profil.name} (${profil.kuerzel})`;
    $("userRolleBadge").innerText = rolle;
    $("adminPanelBtn").style.display = rolle === "Admin" ? "inline-block" : "none";
    if (!datum()) $("aktuellesDatum").value = heute();
    if (rolle === "Sekretariat") startAlarm();
    await klassenLaden();
    zeigeDashboard();
});

async function ladeEinstellungen() {
    const doc = await db.collection("einstellungen").doc("allgemein").get();
    if (!doc.exists) return;
    const d = doc.data();
    cfg = { text: d.schuljahr || "", start: d.startDatum || "", end: d.endDatum || "" };
    zeiten = d.zeiten || [];
    $("schuljahrAnzeige").innerText = cfg.text ? `Sj. ${cfg.text}` : "";
}

async function ladeLehrer() {
    const snap = await db.collection("lehrerProfile").get();
    lehrer = {};
    snap.forEach(d => lehrer[d.id] = d.data());
}

async function klassenLaden() {
    const snap = await db.collection("klassen").get();
    klassenLeiter = {};
    snap.docs.forEach(d => klassenLeiter[d.id] = d.data().klassenleiter || "");
    const opts = snap.docs.map(d => `<option value="${esc(d.id)}">Klasse ${esc(d.id)}</option>`).join("");
    $("klassenAuswahl").innerHTML = opts;
    $("klassenAuswahlDashboard").innerHTML = '<option value="">-- Klasse wählen --</option>' + opts;
    const box = $("meineKlassenLinks");
    box.innerHTML = "";
    snap.docs.filter(d => rolle === "Admin" || d.data().klassenleiter === uid).forEach(d => {
        const b = document.createElement("button");
        b.className = "btn btn-secondary class-panel-btn";
        b.textContent = `📘 Klasse ${d.id}`;
        b.onclick = () => oeffneKlassenbuch(d.id);
        box.appendChild(b);
    });
}

function datumGeaendert() {
    if (ansicht === "dashboardView" || ansicht === "abwesenheitenView") arbeitsbereichLaden();
    else if (ansicht === "klassenbuchView") klassenbuchLaden();
}

function zeigeDashboard() {
    showView("dashboardView");
    $("klassenAuswahl").style.display = "none";
    $("stundenplanEditBtn").style.display = "none";
    arbeitsbereichLaden();
}

// ==========================================================================
// ARBEITSBEREICH (klassenübergreifend)
// ==========================================================================
async function arbeitsbereichLaden() {
    const meine = ++dashZaehler, d = datum(), w = wochenInfo(d);
    const titel = `${TAGE[w.tag]}, ${datumDE(d)}`;
    ["datumTitel", "planTitel", "abwDatum"].forEach(id => $(id).innerText = titel);
    $("wochenTypAnzeige").innerText = `${w.typ}-Woche (KW ${w.kw})`;
    const mein = [], tab = new Map();

    const [klassen, abwSnap] = await Promise.all([db.collection("klassen").get(), db.collection("abwesenheiten").where("bis", ">=", d).get()]);
    const abw = abwSnap.docs.map(x => ({ id: x.id, ...x.data() })).filter(a => a.von <= d);
    abw.forEach(a => tab.set(`${a.klasse}|${a.schueler}`, { klasse: a.klasse, name: a.schueler, status: a.status, grund: a.grund, rec: true }));

    if (w.werktag) {
        await Promise.all(klassen.docs.map(async k => {
            const pd = await planRef(k.id, w.id).get();
            await Promise.all((pd.exists ? pd.data().stunden || [] : []).map(async s => {
                const b = await db.collection("klassenbuch").doc(keyOf(k.id, d, s.std)).get();
                const x = b.exists ? b.data() : {};
                const ab = abwesende(k.id, d, s.std, x, abw);
                ab.forEach(a => { const key = `${k.id}|${a.name}`; if (!tab.has(key)) tab.set(key, { klasse: k.id, ...a }); });
                if (!x.istAusfall && profil.kuerzel && (x.vLehrer || s.lehrer) === profil.kuerzel)
                    mein.push({ k: k.id, std: s.std, zeit: s.zeit, fach: x.vFach || s.fach, signiert: !!x.isSigniert, absent: ab });
            }));
        }));
    }
    // Klassenleitung: offene Abwesenheiten (gemeldet / unentschuldigt) der eigenen Klasse(n)
    const meineKl = Object.keys(klassenLeiter).filter(k => klassenLeiter[k] === uid);
    const klasseAbwNeu = [];
    if (meineKl.length) {
        const sn = await db.collection("abwesenheiten").where("klasse", "in", meineKl.slice(0, 30)).get();
        sn.docs.forEach(q => { const a = q.data(); if (a.status !== "Entschuldigt") klasseAbwNeu.push({ id: q.id, ...a, name: a.schueler }); });
        [...tab.values()].filter(e => !e.rec && meineKl.includes(e.klasse) && e.status !== "Entschuldigt")
            .forEach(e => klasseAbwNeu.push({ ...e, art: "Tag", von: d, bis: d, stunden: [], notiz: "" }));
        klasseAbwNeu.sort((a, b) => (a.status === "Unentschuldigt" ? 0 : 1) - (b.status === "Unentschuldigt" ? 0 : 1) || a.von.localeCompare(b.von));
    }
    if (meine !== dashZaehler) return;   // neuere Abfrage läuft schon
    mein.sort((a, b) => a.std - b.std || a.k.localeCompare(b.k));
    const offene = mein.filter(m => !m.signiert);
    const oeffnen = m => `<button class="btn btn-secondary" style="padding:3px 10px;" onclick="oeffneStundeAusDashboard('${esc(m.k)}', ${m.std})">Öffnen</button>`;

    $("meinPlanListe").innerHTML = mein.map(m => `<div class="plan-karte">
        <div class="pk-std"><strong>${m.std}. Stunde</strong><small>${esc(m.zeit)}</small></div>
        <div class="pk-fach"><b>${esc(m.k)}</b><small>${esc(m.fach)}</small></div>
        <div class="pk-gem"><div class="pk-kopf">Gemeldet:</div>${m.absent.map(a => `<span class="abw-name st-${FARBE[a.status]}" title="${esc(a.grund || a.status)}">${esc(a.name)}</span>`).join("") || "<span class='mute'>–</span>"}</div>
        <div class="pk-akt">${m.signiert ? "✔" : ""} ${oeffnen(m)}</div></div>`).join("") || "<p class='mute'>Kein Unterricht für heute</p>";
    $("offeneListe").innerHTML = offene.map(m => `<div class="plan-zeile"><span><strong>${m.std}.</strong> ${esc(m.fach)} · Klasse ${esc(m.k)}</span>${oeffnen(m)}</div>`).join("");
    $("countUnsigniert").innerText = offene.length;

    const leer = "<li style='color:var(--muted);font-style:italic;'>Keine Einträge</li>";
    const nach = f => [...tab.values()].filter(e => FARBE[e.status] === f)
        .map(e => `<li><span><strong>${esc(e.name)}</strong> (${esc(e.klasse)})</span> <small>${esc(e.grund || e.status)}</small></li>`).join("") || leer;
    $("listeEntschuldigt").innerHTML = nach("e");
    $("listeAbgemeldet").innerHTML = nach("g");
    $("listeUnentschuldigt").innerHTML = nach("u");

    klasseAbw = klasseAbwNeu;
    $("klasseAbwBox").style.display = meineKl.length ? "block" : "none";
    $("countKlasseAbw").innerText = klasseAbw.length;
    $("klasseAbwListe").innerHTML = klasseAbw.map((e, i) => `<div class="plan-zeile"><span><span class="abw-name st-${FARBE[e.status]}">${esc(e.name)}</span>
        <small class="mute">${esc(e.klasse)} · ${esc(abwBereich(e))}${e.grund ? " · " + esc(e.grund) : ""}</small></span>
        <button class="btn btn-secondary" style="padding:3px 10px;" onclick="abwBearbeitenOeffnen(${i})">Bearbeiten</button></div>`).join("")
        || "<p class='mute'>Keine offenen Abwesenheiten.</p>";
}

async function oeffneStundeAusDashboard(k, std) {
    $("klassenAuswahl").value = k;
    await klassenDatenLaden();
    oeffneStunde(std);
}

// ==========================================================================
// KLASSENBUCH EINER KLASSE
// ==========================================================================
function oeffneKlassenbuch(k) {
    $("klassenAuswahl").value = k;
    showView("klassenbuchView");
    $("klassenAuswahl").style.display = "inline-block";
    klassenbuchLaden();
}

function oeffneFremdeKlasse() {
    const k = $("klassenAuswahlDashboard").value;
    if (!k) return alert("Bitte wähle zuerst eine Klasse aus!");
    oeffneKlassenbuch(k);
}

async function klassenDatenLaden() {
    const k = klasse(), w = wochenInfo(datum());
    const [kd, ss, pd] = await Promise.all([
        db.collection("klassen").doc(k).get(),
        db.collection("schueler").where("klasse", "==", k).get(),
        w.werktag ? planRef(k, w.id).get() : Promise.resolve(null)
    ]);
    aktLeiter = kd.exists ? kd.data().klassenleiter || "" : "";
    schueler = ss.docs.map(x => x.data().name).sort((a, b) => a.localeCompare(b, "de"));
    plan = (pd && pd.exists ? pd.data().stunden || [] : []).sort((a, b) => a.std - b.std);
}

async function klassenbuchLaden() {
    const k = klasse(), d = datum(), w = wochenInfo(d), tb = $("tagesStundenBody");
    $("klassenTitel").innerText = `Klassenbuch Klasse ${k}`;
    if (!w.werktag) { tb.innerHTML = "<tr><td colspan='6' style='text-align:center;'>Wochenende</td></tr>"; return; }
    await klassenDatenLaden();
    $("klassenleiterInfo").innerText = `Klassenleiter: ${lehrer[aktLeiter]?.name || "Keiner"}`;
    $("stundenplanEditBtn").style.display = rolle === "Admin" || uid === aktLeiter ? "inline-block" : "none";
    if (!plan.length) { tb.innerHTML = "<tr><td colspan='6' style='text-align:center;'>Kein Plan eingetragen.</td></tr>"; return; }
    const docs = await Promise.all(plan.map(s => db.collection("klassenbuch").doc(keyOf(k, d, s.std)).get()));

    tb.innerHTML = plan.map((s, i) => {
        const x = docs[i].exists ? docs[i].data() : {};
        let wer = x.vLehrer || s.lehrer, fach;
        if (x.istAusfall) {
            fach = `<div class="fach-haupttext" style="text-decoration:line-through;color:var(--danger);">${esc(s.fach)}</div><div class="ausfall-text">(Ausfall)</div>`;
            wer = "-";
        } else if (x.vFach && x.vFach !== s.fach) {
            fach = `<div class="fach-haupttext">${esc(x.vFach)}</div><div class="vertretung-subtext">statt ${esc(s.fach)}</div>`;
        } else {
            fach = `<div class="fach-haupttext">${esc(s.fach)}</div>`;
        }
        return `<tr style="${x.isSigniert ? "opacity:.7;" : ""}">
            <td><strong>${s.std}</strong><small style="display:block;color:var(--muted);">${esc(s.zeit)}</small></td>
            <td>${fach}</td>
            <td>${esc(x.thema) || "<em>Kein Eintrag</em>"}</td>
            <td>${esc(x.hausaufgaben) || "<em>Kein Eintrag</em>"}</td>
            <td><strong>${esc(wer)}</strong> ${x.isSigniert ? "🔒" : ""}</td>
            <td><button class="btn btn-primary" style="padding:4px 8px;font-size:12px;" onclick="oeffneStunde(${s.std})">Öffnen</button></td></tr>`;
    }).join("");
}

// ==========================================================================
// STUNDE ÖFFNEN & BEARBEITEN
// Eintragen: nur Fachlehrer/Vertretung/Admin. Sekretariat: nie.
// Entschuldigen/Freistellen: Sekretariat, Admin, Klassenleitung der eigenen Klasse.
// ==========================================================================
async function oeffneStunde(std) {
    stdNr = std;
    const info = plan.find(s => s.std === std) || { std, lehrer: "Unbekannt", fach: "Fach" };
    const doc = await stdRef(std).get();
    const x = doc.exists ? doc.data() : {};
    const lk = x.vLehrer || info.lehrer, ausfall = !!x.istAusfall, signiert = !!x.isSigniert;
    const kannEintragen = rolle !== "Sekretariat";
    const berechtigt = rolle === "Admin" || (kannEintragen && !!profil.kuerzel && lk === profil.kuerzel && !ausfall);
    const gesperrt = signiert || !berechtigt;
    const darfEntsch = rolle === "Admin" || rolle === "Sekretariat" || uid === aktLeiter;

    $("detailStundeTitel").innerText = `${TAGE[wochenInfo(datum()).tag]}, ${datumDE(datum())} ${x.vFach || info.fach} | Klasse: ${klasse()} | Lehrer: ${lehrer[Object.keys(lehrer).find(u => lehrer[u].kuerzel === lk)]?.name || lk}`;
    $("unterrichtsThema").value = x.thema || "";
    $("unterrichtsInhalt").value = x.inhalt || "";
    $("hausaufgabenInhalt").value = x.hausaufgaben || "";
    [$("unterrichtsThema"), $("unterrichtsInhalt"), $("hausaufgabenInhalt")].forEach(e => e.disabled = gesperrt);
    themaHinweisPruefen();
    $("themaHinweis").style.display = !gesperrt && !x.thema ? "block" : "none";

    const h = $("statusHinweisBox");
    h.style.display = gesperrt ? "block" : "none";
    h.style.background = signiert ? "var(--success-soft)" : "var(--bg-input)";
    h.innerText = signiert ? "Gesperrt: Diese Stunde wurde elektronisch signiert."
        : kannEintragen ? "Schreibgeschützt: Nicht dein Fachlehrer-Kürzel." : "Das Sekretariat kann Abwesenheiten bearbeiten, aber keine Einträge machen.";

    const an = (id, ok) => $(id).style.display = ok ? "inline-block" : "none";
    an("btnUnterrichtAendern", berechtigt && !signiert);
    an("btnStundeSpeichern", berechtigt && !signiert);
    an("btnUnterrichtSignieren", berechtigt && !signiert);
    an("btnUnterrichtUebernehmen", kannEintragen && !signiert && (lk !== profil.kuerzel || ausfall));
    an("btnSignumZuruecknehmen", signiert && berechtigt);

    const d = datum();
    const abw = (await db.collection("abwesenheiten").where("klasse", "==", klasse()).get()).docs.map(q => ({ id: q.id, ...q.data() })).filter(a => a.von <= d && d <= a.bis);
    const am = new Map(abwesende(klasse(), d, std, x, abw).map(a => [a.name, a]));
    $("schuelerDetailListe").innerHTML = schueler.map((n, i) => {
        const e = am.get(n);
        const kipp = `<label class="kipp"><input type="checkbox" data-name="${esc(n)}" ${e ? "" : "checked"} ${gesperrt || (e && e.id) ? "disabled" : ""} onchange="anwesenheitKippen(this)" aria-label="Anwesend"><span class="kipp-ui"></span></label>`;
        let rechts = "";
        if (e) {
            const bereich = e.art === "Zeitraum" ? `${datumDE(e.von)} - ${datumDE(e.bis)}` : e.art === "Stunden" ? `Std. ${(e.stunden || []).join(", ")}` : "";
            rechts = `<span class="abw-badge st-${FARBE[e.status]}" title="${esc(e.notiz || "")}">${esc(e.grund || e.status)}</span><small class="mute">${esc(bereich)}</small>`
                + (e.id && darfEntsch ? `<button class="note-del" onclick="abwesenheitLoeschen('${e.id}')" title="Abwesenheit löschen" aria-label="Abwesenheit löschen">×</button>` : "");
        }
        return `<li class="schueler-item"><span class="nr">${i + 1}</span>${kipp}<span class="sname">${esc(n)}</span>${rechts}</li>`;
    }).join("");
    showView("detailView");
}

const zurueckAusDetails = () => oeffneKlassenbuch(klasse());
const stundeSetzen = obj => stdRef(stdNr).set({ datum: datum(), klasse: klasse(), std: stdNr, ...obj }, { merge: true }).then(() => oeffneStunde(stdNr));
const textFelder = () => ({ thema: $("unterrichtsThema").value.trim(), inhalt: $("unterrichtsInhalt").value, hausaufgaben: $("hausaufgabenInhalt").value });
const stundeSpeichern = () => stundeSetzen(textFelder()).then(() => alert("Gespeichert."));
const signumZuruecknehmen = () => stundeSetzen({ isSigniert: false });
const themaHinweisPruefen = () => $("themaHinweis").style.display = $("unterrichtsThema").value.trim() ? "none" : "block";
const setzeStatus = (n, st) => stundeSetzen({ anwesenheit: { [n]: st } });
const anwesenheitKippen = cb => setzeStatus(cb.dataset.name, cb.checked ? "Anwesend" : "Unentschuldigt");
async function abwesenheitLoeschen(id) {
    if (!confirm("Diese Abwesenheit löschen?")) return;
    await db.collection("abwesenheiten").doc(id).delete();
    oeffneStunde(stdNr);
}

function stundeSignieren() {
    const t = textFelder();
    if (!t.thema) return alert("Bitte zuerst ein Unterrichtsthema eintragen.");
    stundeSetzen({ ...t, isSigniert: true });
}

function unterrichtAendernDialog() {
    const f = prompt("Neues Fachkürzel eingeben (oder 'AUSFALL' für Stundenausfall):");
    if (!f || !f.trim()) return;
    if (f.trim().toUpperCase() === "AUSFALL") return stundeSetzen({ istAusfall: true, vFach: "", vLehrer: "" });
    const l = prompt("Welcher Lehrer hält die Vertretung? (Kürzel)");
    if (!l) return;
    stundeSetzen({ istAusfall: false, vFach: f.trim().toUpperCase(), vLehrer: l.trim().toUpperCase() });
}

function unterrichtUebernehmenDialog() {
    let fach = (plan.find(s => s.std === stdNr) || { fach: "Fach" }).fach;
    if (!confirm(`Möchtest du das aktuelle Fach (${fach}) beibehalten?`)) {
        const f = prompt("Welches Fach unterrichtest du?");
        if (!f) return;
        fach = f.trim().toUpperCase();
    }
    stundeSetzen({ istAusfall: false, vFach: fach, vLehrer: profil.kuerzel });
}

// ==========================================================================
// NOTENPROGRAMM
// Collection "noten": klasse, fach, schueler, wert, gewicht, art, datum, lehrer, uid
// ==========================================================================
async function oeffneNoten() {
    const k = klasse();
    notenCtx = { klasse: k, fach: "", eigene: new Set(), schueler: [], noten: [] };
    const plaene = await db.collection("klassen").doc(k).collection("stundenplaene").get();
    const alle = new Set();
    plaene.forEach(d => (d.data().stunden || []).forEach(s => {
        alle.add(s.fach);
        if (s.lehrer === profil.kuerzel) notenCtx.eigene.add(s.fach);
    }));
    $("notenTitel").innerText = `Noten Klasse ${k}`;
    $("notenFach").innerHTML = '<option value="">-- Fach wählen --</option>' +
        [...alle].sort().map(f => `<option value="${esc(f)}">${esc(f)}${notenCtx.eigene.has(f) ? " ★" : ""}</option>`).join("");
    $("notenBody").innerHTML = "";
    $("notenHinweis").style.display = "none";
    showView("notenView");
}

async function notenLaden() {
    const c = notenCtx;
    c.fach = $("notenFach").value;
    if (!c.fach) { $("notenBody").innerHTML = ""; return; }
    const [ss, ns] = await Promise.all([
        db.collection("schueler").where("klasse", "==", c.klasse).get(),
        db.collection("noten").where("klasse", "==", c.klasse).where("fach", "==", c.fach).get()
    ]);
    c.schueler = ss.docs.map(d => d.data().name).sort((a, b) => a.localeCompare(b, "de"));
    c.noten = ns.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.datum.localeCompare(b.datum));
    notenRendern();
}

function notenRendern() {
    const c = notenCtx, darf = rolle === "Admin" || c.eigene.has(c.fach);
    $("notenHinweis").style.display = darf ? "none" : "block";
    $("notenHinweis").innerText = "Nur ansehen: Dieses Fach unterrichtest du in dieser Klasse nicht.";
    $("notenBody").innerHTML = c.schueler.map(name => {
        const l = c.noten.filter(n => n.schueler === name);
        const w = l.reduce((a, n) => a + n.gewicht, 0);
        const schnitt = w ? (l.reduce((a, n) => a + n.wert * n.gewicht, 0) / w).toFixed(2).replace(".", ",") : "–";
        const chips = l.map(n => `<span class="note-chip" title="${esc(n.art)} · ${esc(n.datum)} · ${esc(n.lehrer)}">${String(n.wert).replace(".", ",")}<small>×${n.gewicht}</small>${rolle === "Admin" || n.uid === uid ? `<button class="note-del" onclick="noteLoeschen('${n.id}')" aria-label="Note löschen">×</button>` : ""}</span>`).join("");
        const form = darf ? `<div class="note-form"><input type="number" class="nw" min="1" max="6" step="0.25" placeholder="Note" aria-label="Note">
            <select class="na"><option value="1">Mündlich ×1</option><option value="2">Test ×2</option><option value="3">Klassenarbeit ×3</option></select>
            <button class="btn btn-primary" style="padding:4px 10px;" onclick="noteSpeichern(this)">+</button></div>` : "";
        return `<tr data-name="${esc(name)}"><td><strong>${esc(name)}</strong></td><td>${chips || "<em>Keine Noten</em>"}</td><td><strong>${schnitt}</strong></td><td>${form}</td></tr>`;
    }).join("") || "<tr><td colspan='4'>Keine Schüler in dieser Klasse.</td></tr>";
}

async function noteSpeichern(btn) {
    const tr = btn.closest("tr"), c = notenCtx, art = tr.querySelector(".na");
    const wert = parseFloat(tr.querySelector(".nw").value);
    if (!(wert >= 1 && wert <= 6)) return alert("Bitte eine Note von 1 bis 6 eingeben.");
    await db.collection("noten").add({
        klasse: c.klasse, fach: c.fach, schueler: tr.dataset.name, wert,
        gewicht: +art.value, art: art.selectedOptions[0].text,
        datum: datum() || heute(), lehrer: profil.kuerzel, uid
    });
    notenLaden();
}

async function noteLoeschen(id) {
    if (!confirm("Diese Note löschen?")) return;
    await db.collection("noten").doc(id).delete();
    notenLaden();
}

// ==========================================================================
// STUNDENPLAN-EDITOR
// ==========================================================================
function zeigeStundenplanEditor() {
    showView("stundenplanEditorView");
    $("editWochentag").value = "1";
    $("editWochenTyp").value = "A";
    ladeEditorPlan();
}

async function ladeEditorPlan() {
    const doc = await planRef(klasse(), `${$("editWochentag").value}_${$("editWochenTyp").value}`).get();
    const alt = doc.exists ? doc.data().stunden || [] : [];
    let h = "";
    for (let i = 1; i <= anzahlStunden(); i++) {
        const z = zeiten[i - 1] || "", s = alt.find(x => x.std === i) || { fach: "", lehrer: "" };
        h += `<tr><td><strong>${i}</strong></td><td><span style="font-weight:600;color:var(--muted);">${esc(z) || "Nicht definiert"}</span></td>
            <td><input type="text" id="editFach${i}" value="${esc(s.fach)}"></td>
            <td><input type="text" id="editLehrer${i}" value="${esc(s.lehrer)}"></td></tr>`;
    }
    $("editorStundenBody").innerHTML = h;
}

async function speichereStundenplan() {
    const neu = [];
    for (let i = 1; i <= anzahlStunden(); i++) {
        const fach = $(`editFach${i}`).value.trim(), zeit = zeiten[i - 1] || "";
        if (!fach) continue;
        if (!zeit) return alert(`Für die ${i}. Stunde ist unter Admin → Grundeinstellungen noch keine Zeit eingetragen.`);
        neu.push({ std: i, zeit, fach, lehrer: $(`editLehrer${i}`).value.trim().toUpperCase() });
    }
    await planRef(klasse(), `${$("editWochentag").value}_${$("editWochenTyp").value}`).set({ stunden: neu });
    alert("Stundenplan gespeichert!");
    oeffneKlassenbuch(klasse());
}

// ==========================================================================
// ADMIN
// ==========================================================================
function zeigeAdminPanel() {
    showView("adminPanelView");
    wechsleAdminTab("klassen");
    $("setupZeitenBody").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map(i =>
        `<tr><td><strong>${i}. Stunde</strong></td><td><input type="text" id="setupZeit${i}" value="${esc(zeiten[i - 1] || "")}" placeholder="08:00 - 08:45"></td></tr>`).join("");
}

function wechsleAdminTab(t) {
    const k = t === "klassen";
    $("adminTabKlassen").style.display = k ? "grid" : "none";
    $("adminTabEinstellungen").style.display = k ? "none" : "block";
    $("btnTabKlassen").className = k ? "btn btn-primary" : "btn btn-secondary";
    $("btnTabEinstellungen").className = k ? "btn btn-secondary" : "btn btn-primary";
    if (!k) { ladeGruende().then(zeigeGruende); $("setupSchuljahr").value = cfg.text; $("setupStartDatum").value = cfg.start; $("setupEndDatum").value = cfg.end; }
}

async function speichereGrundeinstellungen() {
    await db.collection("einstellungen").doc("allgemein").set({
        schuljahr: $("setupSchuljahr").value.trim(), startDatum: $("setupStartDatum").value, endDatum: $("setupEndDatum").value,
        zeiten: [1, 2, 3, 4, 5, 6, 7, 8].map(i => $(`setupZeit${i}`).value.trim())
    });
    alert("Grundeinstellungen gesichert!");
    await ladeEinstellungen();
    zeigeDashboard();
}

async function adminLehrerAnlegen() {
    const name = $("setupLehrerName").value.trim(), kuerzel = $("setupLehrerKuerzel").value.trim().toUpperCase(), id = $("setupLehrerUID").value.trim();
    if (!name || !kuerzel || !id) return alert("Bitte alle Felder ausfüllen.");
    await db.collection("lehrerProfile").doc(id).set({ name, kuerzel });
    alert(`Profil für ${name} angelegt!`);
    await ladeLehrer();
}

async function adminKlasseErstellen() {
    const name = $("adminKlassenName").value.trim();
    if (!name) return;
    await db.collection("klassen").doc(name).set({ klassenleiter: $("adminKlassenleiterUID").value.trim() }, { merge: true });
    alert(`Klasse ${name} gespeichert.`);
    klassenLaden();
}

async function adminSchuelerAnlegen() {
    const name = $("adminSchuelerName").value.trim(), k = $("adminSchuelerKlasse").value.trim();
    if (!name || !k) return alert("Bitte Name und Klasse eingeben.");
    if (!(await db.collection("klassen").doc(k).get()).exists) return alert(`Die Klasse ${k} gibt es noch nicht.`);
    await db.collection("schueler").add({ name, klasse: k });
    alert(`Schüler ${name} registriert.`);
    $("adminSchuelerName").value = "";
}

// ==========================================================================
// POPUP: ABWESENHEIT ANLEGEN (Tag / Stunden / Zeitraum)
// ==========================================================================
const kannFarbe = k => rolle === "Admin" || rolle === "Sekretariat" || klassenLeiter[k] === uid;

function farbeWaehlen(s) {
    abwFarbe = s;
    document.querySelectorAll(".farbe").forEach(b => b.classList.toggle("on", b.dataset.s === s));
}

async function oeffneAbwesenheitModal(e) {
    const [ss] = await Promise.all([db.collection("schueler").get(), ladeGruende()]);
    const liste = ss.docs.map(d => d.data()).sort((a, b) => a.name.localeCompare(b.name, "de"));
    $("abwSchueler").innerHTML = '<option value="">Schüler wählen</option>' +
        liste.map(s => `<option value="${esc(s.klasse)}|${esc(s.name)}">${esc(s.name)} (${esc(s.klasse)})</option>`).join("");
    $("abwGrund").innerHTML = '<option value="">– kein Grund –</option>' + gruende.map(g => `<option value="${esc(g.text)}">${esc(g.text)}</option>`).join("");
    $("abwStunden").innerHTML = '<button type="button" class="sk-alle" onclick="abwAlleStunden()">Alle</button>' +
        Array.from({ length: 13 }, (_, i) => `<label class="sk"><input type="checkbox" value="${i + 1}" checked><span>${i + 1}</span></label>`).join("");
    $("abwArt").value = "Tag";
    $("abwVon").value = $("abwBis").value = datum() || heute();
    $("abwNotiz").value = "";
    farbeWaehlen("Unentschuldigt");
    // Bearbeiten: vorhandenen Eintrag (oder eine Kippschalter-Meldung) in dasselbe Fenster laden
    abwBearbeiten = e && e.id ? e : null;
    $("abwTitel").innerText = abwBearbeiten ? "ABWESENHEIT BEARBEITEN" : "ABWESENHEIT";
    $("abwSchueler").disabled = !!e;
    if (e) {
        $("abwSchueler").value = `${e.klasse}|${e.name}`;
        $("abwArt").value = e.art || "Tag";
        $("abwVon").value = e.von; $("abwBis").value = e.bis;
        if (e.art === "Stunden") document.querySelectorAll("#abwStunden input").forEach(b => b.checked = (e.stunden || []).includes(+b.value));
        if (e.grund && ![...$("abwGrund").options].some(o => o.value === e.grund)) $("abwGrund").add(new Option(e.grund, e.grund));
        $("abwGrund").value = e.grund || "";
        $("abwNotiz").value = e.notiz || "";
    }
    abwSchuelerGeaendert();
    if (e) farbeWaehlen(e.status);
    abwArtGeaendert();
    $("abwesenheitModal").style.display = "flex";
}

// Fachlehrer dürfen nur "Unentschuldigt" setzen; Gemeldet/Entschuldigt: Sekretariat, Admin, Klassenleitung der Klasse
function abwSchuelerGeaendert() {
    const k = $("abwSchueler").value.split("|")[0];
    const frei = !k || kannFarbe(k);
    document.querySelectorAll(".farbe.f-g, .farbe.f-e").forEach(b => b.disabled = !frei);
    if (!frei) farbeWaehlen("Unentschuldigt");
}

function abwArtGeaendert() {
    const art = $("abwArt").value;
    $("abwBisBox").style.display = art === "Zeitraum" ? "block" : "none";
    $("abwStundenBox").style.display = art === "Stunden" ? "block" : "none";
}

function abwAlleStunden() {
    const boxen = [...document.querySelectorAll("#abwStunden input")], alle = boxen.every(b => b.checked);
    boxen.forEach(b => b.checked = !alle);
}

function schliesseAbwesenheitModal() {
    abwBearbeiten = null;
    $("abwSchueler").disabled = false;
    $("abwesenheitModal").style.display = "none";
}

async function speichereAbwesenheit() {
    const v = $("abwSchueler").value;
    if (!v) return alert("Bitte einen Schüler wählen.");
    const i = v.indexOf("|"), k = v.slice(0, i), name = v.slice(i + 1);
    if (abwFarbe !== "Unentschuldigt" && !kannFarbe(k)) return alert("Diesen Status darfst du für diese Klasse nicht setzen.");
    const art = $("abwArt").value, von = $("abwVon").value, bis = art === "Zeitraum" ? $("abwBis").value : von;
    if (!von || !bis || bis < von) return alert("Bitte ein gültiges Datum bzw. einen gültigen Zeitraum eingeben.");
    let stunden = [];
    if (art === "Stunden") {
        stunden = [...document.querySelectorAll("#abwStunden input:checked")].map(b => +b.value);
        if (!stunden.length) return alert("Bitte mindestens eine Stunde wählen.");
    }
    const felder = { art, von, bis, stunden, status: abwFarbe, grund: $("abwGrund").value, notiz: $("abwNotiz").value.trim() };
    if (abwBearbeiten) await db.collection("abwesenheiten").doc(abwBearbeiten.id).update(felder);
    else await db.collection("abwesenheiten").add({ klasse: k, schueler: name, ...felder, von_kuerzel: profil.kuerzel || profil.name, uid });
    schliesseAbwesenheitModal();
    if (ansicht === "detailView") oeffneStunde(stdNr);
    else if (ansicht === "klassenbuchView") klassenbuchLaden();
    else arbeitsbereichLaden();
}

// ==========================================================================
// ADMIN: GRÜNDE DER ABWESENHEIT
// ==========================================================================
async function ladeGruende() {
    const snap = await db.collection("abwesenheitsgruende").get();
    gruende = snap.docs.map(d => ({ id: d.id, text: d.data().text })).sort((a, b) => a.text.localeCompare(b.text, "de"));
}

function zeigeGruende() {
    $("gruendeListe").innerHTML = gruende.map(g => `<div class="plan-zeile"><span>${esc(g.text)}</span><span>
        <button class="btn btn-secondary" style="padding:3px 10px;" onclick="grundBearbeiten('${g.id}')">Bearbeiten</button>
        <button class="btn btn-danger" style="padding:3px 10px;" onclick="grundLoeschen('${g.id}')">Löschen</button></span></div>`).join("")
        || "<p class='mute'>Noch keine Gründe angelegt.</p>";
}

async function grundHinzufuegen() {
    const t = $("neuerGrund").value.trim();
    if (!t) return;
    await db.collection("abwesenheitsgruende").add({ text: t });
    $("neuerGrund").value = "";
    await ladeGruende(); zeigeGruende();
}

async function grundBearbeiten(id) {
    const t = prompt("Grund bearbeiten (bereits gespeicherte Abwesenheiten behalten den alten Text):", gruende.find(g => g.id === id).text);
    if (!t || !t.trim()) return;
    await db.collection("abwesenheitsgruende").doc(id).update({ text: t.trim() });
    await ladeGruende(); zeigeGruende();
}

async function grundLoeschen(id) {
    if (!confirm("Diesen Grund löschen? Bereits gespeicherte Abwesenheiten bleiben unverändert.")) return;
    await db.collection("abwesenheitsgruende").doc(id).delete();
    await ladeGruende(); zeigeGruende();
}

// ==========================================================================
// TAGE, ABWESENHEITEN-TAB
// ==========================================================================
function tagWechsel(n) {
    const d = new Date(datum() + "T12:00:00");
    d.setDate(d.getDate() + n);
    $("aktuellesDatum").value = d.toLocaleDateString("sv-SE");
    datumGeaendert();
}
function heuteSetzen() { $("aktuellesDatum").value = heute(); datumGeaendert(); }
function zeigeAbwesenheiten() {
    showView("abwesenheitenView");
    $("klassenAuswahl").style.display = "none";
    $("stundenplanEditBtn").style.display = "none";
    arbeitsbereichLaden();
}

// ==========================================================================
// SEKRETARIAT: roter Balken + Ton, sobald ein Schüler unentschuldigt fehlt
// (Live-Abfrage; benötigt das Feld "datum" in klassenbuch, wird beim Speichern gesetzt)
// ==========================================================================
function piepton() {
    try {
        audioCtx = audioCtx || new AudioContext();
        audioCtx.resume();
        [0, 0.35, 0.7].forEach(t => {
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.frequency.value = 880; g.gain.value = 0.2;
            o.connect(g); g.connect(audioCtx.destination);
            o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.2);
        });
    } catch (e) { /* Ton nicht möglich */ }
}

function startAlarm() {
    if (alarmStop) alarmStop();
    document.addEventListener("click", () => { audioCtx = audioCtx || new AudioContext(); audioCtx.resume(); }, { once: true });
    let recs = [], lessons = [];
    const rechne = () => {
        const d = heute(), offen = new Map();
        recs.filter(a => a.status === "Unentschuldigt").forEach(a => offen.set(`${a.klasse}|${a.schueler}`, { klasse: a.klasse, name: a.schueler }));
        lessons.forEach(l => {   // Kippschalter-Meldungen zählen nur, wenn kein Abwesenheits-Eintrag den Schüler schon erfasst
            if (!recs.some(a => a.klasse === l.klasse && a.schueler === l.name && deckt(a, d, l.std))) offen.set(`${l.klasse}|${l.name}`, { klasse: l.klasse, name: l.name });
        });
        const neu = [...offen.keys()].some(k => !bekannt.has(k));
        bekannt = new Set(offen.keys());
        const b = $("sekBanner");
        b.style.display = offen.size ? "flex" : "none";
        b.innerHTML = `<strong>⚠ Unentschuldigt fehlt:</strong><span>${[...offen.values()].map(l => `${esc(l.name)} (${esc(l.klasse)})`).join(", ")}</span><button class="btn btn-secondary" onclick="piepton()">🔔 Ton testen</button>`;
        if (neu) piepton();
    };
    const s1 = db.collection("klassenbuch").where("datum", "==", heute()).onSnapshot(snap => {
        lessons = [];
        snap.forEach(doc => { const x = doc.data(); Object.entries(x.anwesenheit || {}).forEach(([n, st]) => { if (st === "Unentschuldigt") lessons.push({ klasse: x.klasse, name: n, std: x.std }); }); });
        rechne();
    }, e => console.error("Alarm (Stunden) fehlgeschlagen", e));
    const s2 = db.collection("abwesenheiten").where("bis", ">=", heute()).onSnapshot(snap => {
        recs = snap.docs.map(x => x.data()).filter(a => a.von <= heute());
        rechne();
    }, e => console.error("Alarm (Abwesenheiten) fehlgeschlagen", e));
    alarmStop = () => { s1(); s2(); };
}

const abwBearbeitenOeffnen = i => oeffneAbwesenheitModal(klasseAbw[i]);
