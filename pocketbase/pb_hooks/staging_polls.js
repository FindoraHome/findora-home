const day = 24 * 60 * 60 * 1000;
const delivery = require(`${__hooks}/staging_delivery.js`);

function pollOptions(record) {
    return JSON.parse(record.getString("options"));
}

function pollInfo(record, options = pollOptions(record)) {
    return {
        id: record.id,
        question: record.getString("question"),
        free_text: options.some(option => option.id === 0),
        ends_at: record.getString("ends_at").replace(" ", "T"),
    };
}

function ballots(app, poll) {
    return app.findRecordsByFilter("staging_poll_ballots", "poll = {:poll}", "", 0, 0, { poll });
}

function participantCount(record, votes) {
    return record.getInt("imported_participants") + votes.length;
}

function summarizeResponses(responses) {
    const ignored = new Set("aber auch auf aus bei bin bis das dass dem den der des die dir doch ein eine einer eines für hat ich ihr ist kann kein man mehr mich mir mit nach nicht noch nur oder sehr sie sind über und uns vom von war was weil wenn wie wir wird zum zur".split(" "));
    const counts = new Map();
    for (const response of responses) {
        const words = new Set(response.toLowerCase().match(/[a-zäöüß]{3,}/g) || []);
        for (const word of words) {
            if (!ignored.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
        }
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
}

function adminPoll(app, record) {
    const votes = ballots(app, record.id);
    const options = pollOptions(record);
    const info = pollInfo(record, options);
    const ended = !record.getBool("active") || Date.parse(info.ends_at) <= Date.now();
    const counts = new Map(options.map(option => [option.id, option.votes || 0]));
    const responses = [];
    if (!info.free_text || ended) {
        for (const ballot of votes) {
            for (const choice of JSON.parse(ballot.getString("choices"))) {
                if (info.free_text && typeof choice === "string") responses.push(choice);
                else if (counts.has(choice)) counts.set(choice, counts.get(choice) + 1);
            }
        }
    }
    return {
        ...info,
        active: record.getBool("active"),
        ended,
        created_at: record.getString("created_at").replace(" ", "T"),
        participant_goal: record.getInt("participant_goal") || null,
        total_votes: participantCount(record, votes),
        options: options.filter(option => option.id !== 0).map(({ id, label, image_url }) => ({ id, label, image_url, votes: counts.get(id) })),
        responses,
        summary: responses.length ? summarizeResponses(responses) : [],
    };
}

function duration(value) {
    if (!Number.isInteger(value) || value < 1 || value > 365) {
        throw new BadRequestError("Der Zeitraum muss zwischen 1 und 365 Tagen liegen.");
    }
    return value * day;
}

function pollContent(input, previous = null) {
    const question = typeof input.p_question === "string" ? input.p_question.trim() : "";
    const questionLength = Array.from(question).length;
    if (questionLength < 3 || questionLength > 300) throw new BadRequestError("Bitte eine gültige Frage eintragen.");
    const answers = input.p_options;
    const freeText = input.p_free_text === true;
    if (previous) {
        const sameMode = previous.some(option => option.id === 0) === freeText;
        const sameOptions = Array.isArray(answers) && answers.length === previous.length &&
            previous.every((option, index) => answers[index]?.id === option.id);
        if (!sameMode || (!freeText && !sameOptions)) {
            throw new BadRequestError("Antwortmöglichkeiten einer laufenden Abstimmung müssen erhalten bleiben.");
        }
    } else if (!freeText && (!Array.isArray(answers) || answers.length < 2 || answers.length > 50)) {
        throw new BadRequestError("Bitte zwei bis fünfzig Antworten eintragen.");
    }
    const options = freeText ? [{ id: 0, label: "", votes: 0 }] : answers.map((answer, index) => {
        const value = typeof answer === "string" ? answer : answer?.label;
        const label = typeof value === "string" ? value.trim() : "";
        if (!label || Array.from(label).length > 200) throw new BadRequestError("Bitte überprüfe die Antworten.");
        const image_url = typeof answer?.image_url === "string" ? answer.image_url.trim() : "";
        const uploadedImage = image_url.length <= 40000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image_url);
        const linkedImage = image_url.length <= 1000 && /^https:\/\/[^\s]+$/i.test(image_url);
        if (image_url && !uploadedImage && !linkedImage) throw new BadRequestError("Ungültiges oder zu großes Antwortbild.");
        const original = previous?.[index];
        return { id: original?.id ?? index + 1, label, ...(image_url ? { image_url } : {}), votes: original?.votes ?? 0 };
    });
    if (JSON.stringify(options).length > 900000) throw new BadRequestError("Die Antwortbilder sind zusammen zu groß.");
    return { question, options };
}

function create(app, input) {
    const { question, options } = pollContent(input);
    const now = Date.now();
    const record = new Record(app.findCollectionByNameOrId("staging_polls"));
    record.set("question", question);
    record.set("options", options);
    record.set("created_at", new Date(now).toISOString());
    record.set("ends_at", new Date(now + duration(input.p_duration_days)).toISOString());
    record.set("active", true);
    app.save(record);
    return record.id;
}

function findPoll(app, id) {
    if (typeof id !== "string" || !/^[a-z0-9]{15}$/.test(id)) throw new BadRequestError("Ungültige Abstimmung.");
    const record = app.findRecordsByFilter("staging_polls", "id = {:id}", "", 1, 0, { id })[0];
    if (!record) throw new NotFoundError("Abstimmung wurde nicht gefunden.");
    return record;
}

function endPoll(record) {
    record.set("active", false);
    record.set("ends_at", new Date().toISOString());
}

function admin(e) {
    const action = e.request.pathValue("action");
    const input = e.requestInfo().body;
    if (action === "get_admin_polls") {
        const page = input.p_page;
        if (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > 100000)) {
            throw new BadRequestError("Ungültige Seite.");
        }
        const pageSize = 10;
        const records = e.app.findRecordsByFilter("staging_polls", "", "-created_at,-id",
            page === undefined ? 50 : pageSize + 1, page === undefined ? 0 : (page - 1) * pageSize);
        const visible = page === undefined ? records : records.slice(0, pageSize);
        return e.json(200, { data: visible.map(record => adminPoll(e.app, record)), has_more: page !== undefined && records.length > pageSize });
    }
    if (action === "create_site_poll") return e.json(200, { data: create(e.app, input) });
    e.app.runInTransaction(app => {
        const poll = findPoll(app, input.p_poll_id);
        switch (action) {
            case "edit_site_poll": {
                if (!poll.getBool("active") || Date.parse(poll.getString("ends_at").replace(" ", "T")) <= Date.now()) {
                    throw new BadRequestError("Diese Abstimmung ist bereits beendet.");
                }
                const { question, options } = pollContent(input, pollOptions(poll));
                poll.set("question", question);
                poll.set("options", options);
                break;
            }
            case "delete_site_poll":
                app.delete(poll);
                return;
            case "close_site_poll":
                poll.set("active", false);
                break;
            case "set_site_poll_duration":
                poll.set("ends_at", new Date(Date.now() + duration(input.p_days_from_now)).toISOString());
                poll.set("active", true);
                break;
            case "set_site_poll_participant_goal": {
                const goal = input.p_participant_goal;
                if (goal !== null && (!Number.isInteger(goal) || goal < 1 || goal > 100000)) {
                    throw new BadRequestError("Das Teilnehmerziel muss zwischen 1 und 100.000 liegen.");
                }
                poll.set("participant_goal", goal || 0);
                if (goal && participantCount(poll, ballots(app, poll.id)) >= goal) poll.set("active", false);
                break;
            }
            default:
                throw new NotFoundError();
        }
        app.save(poll);
    });
    return e.json(200, { data: null });
}

function visitor(e) {
    const action = e.request.pathValue("action");
    const input = e.requestInfo().body;
    const token = input.p_visitor_token;
    if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token)) throw new BadRequestError("Ungültige Besucherkennung.");
    const voter = $security.sha256(token);
    if (action === "get_active_polls") {
        const voted = new Set(e.app.findRecordsByFilter("staging_poll_ballots", "voter = {:voter}", "", 0, 0, { voter })
            .map(record => record.getString("poll")));
        const polls = e.app.findRecordsByFilter("staging_polls", "active = true && ends_at > @now", "-created_at,-id", 0, 0);
        return e.json(200, { data: polls.map(poll => {
            const options = pollOptions(poll);
            return { ...pollInfo(poll, options), has_voted: voted.has(poll.id),
                options: options.filter(option => option.id !== 0).map(({ id, label, image_url }) => ({ id, label, image_url })) };
        }) });
    }
    if (action !== "vote_in_poll_multi") throw new NotFoundError();
    let notice;
    e.app.runInTransaction(app => {
        const poll = findPoll(app, input.p_poll_id);
        const options = pollOptions(poll);
        const info = pollInfo(poll, options);
        if (!poll.getBool("active") || Date.parse(info.ends_at) <= Date.now()) {
            throw new BadRequestError("Diese Abstimmung ist nicht mehr aktiv.");
        }
        const response = typeof input.p_response === "string" ? input.p_response.trim() : "";
        if (info.free_text && (!response || response.length > 1000)) throw new BadRequestError("Bitte eine Antwort mit bis zu 1.000 Zeichen eingeben.");
        if (!info.free_text && (!Array.isArray(input.p_option_ids) || !input.p_option_ids.length || input.p_option_ids.length > options.length)) {
            throw new BadRequestError("Bitte mindestens eine Antwort auswählen.");
        }
        const choices = info.free_text ? [response] : [...new Set(input.p_option_ids)];
        if (!info.free_text && !choices.every(choice => options.some(option => option.id === choice))) {
            throw new BadRequestError("Eine Antwort gehört nicht zur Abstimmung.");
        }
        const previous = app.findRecordsByFilter("staging_poll_ballots", "poll = {:poll} && voter = {:voter}", "", 1, 0,
            { poll: poll.id, voter });
        if (previous.length) throw new ApiError(409, "Du hast bereits abgestimmt.");
        const ballot = new Record(app.findCollectionByNameOrId("staging_poll_ballots"));
        ballot.set("poll", poll.id);
        ballot.set("voter", voter);
        ballot.set("choices", choices);
        app.save(ballot);
        const selected = info.free_text ? ["Freitextantwort gespeichert. Auswertung nach Ende der Frage."] : options.filter(option => choices.includes(option.id)).map(option => `• ${option.label}`);
        const participants = participantCount(poll, ballots(app, poll.id));
        notice = `🗳️ Neue Abstimmung\n\n❓ ${poll.getString("question")}\n✅ Gewählt:\n${selected.join("\n")}\n\n👥 Teilnehmer bisher: ${participants}\n🕒 ${delivery.telegramTime()}`;
        const goal = poll.getInt("participant_goal");
        if (goal && participants >= goal) {
            endPoll(poll);
            app.save(poll);
        }
    });
    delivery.enqueue(e.app, "dolly", notice, "", $security.sha256(e.realIP()));
    return e.json(200, { data: null });
}

function queueResults(app) {
    if (!$os.getenv("FINDORA_STAGING_DOLLY_TELEGRAM_BOT_TOKEN")) return;
    const scope = $os.getenv("FINDORA_SITE_MODE") === "production" ? "" : "legacy_id = '' && ";
    const records = app.findRecordsByFilter("staging_polls", `${scope}(active = false || ends_at <= @now)`, "ends_at", 0, 0);
    for (const record of records) {
        const poll = adminPoll(app, record);
        const options = poll.free_text ? [`Freitextantworten: ${poll.responses.length}. Auswertung in der Verwaltung.`] : poll.options.map(option => `• ${option.label}: ${option.votes} Stimmen`);
        const result = `📊 Abstimmung beendet\n\n❓ ${poll.question}\n\n${options.join("\n") || "Keine Stimmen abgegeben."}\n\n👥 Teilnehmer: ${poll.total_votes}\n🕒 Ende: ${delivery.telegramTime(poll.ends_at)}`;
        delivery.enqueue(app, "dolly", result, `poll-result:${poll.id}:${poll.ends_at}`);
    }
}

module.exports = { admin, visitor, queueResults };
