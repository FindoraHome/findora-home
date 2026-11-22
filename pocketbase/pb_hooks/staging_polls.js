const day = 24 * 60 * 60 * 1000;
const delivery = require(`${__hooks}/staging_delivery.js`);

function pollOptions(record) {
    return JSON.parse(record.getString("options"));
}

function pollInfo(record) {
    return {
        id: record.id,
        question: record.getString("question"),
        ends_at: record.getString("ends_at").replace(" ", "T"),
    };
}

function ballots(app, poll) {
    return app.findRecordsByFilter("staging_poll_ballots", "poll = {:poll}", "", 0, 0, { poll });
}

function participantCount(record, votes) {
    return record.getInt("imported_participants") + votes.length;
}

function adminPoll(app, record) {
    const votes = ballots(app, record.id);
    const options = pollOptions(record);
    const counts = new Map(options.map(option => [option.id, option.votes]));
    for (const ballot of votes) {
        for (const choice of JSON.parse(ballot.getString("choices"))) counts.set(choice, counts.get(choice) + 1);
    }
    return {
        ...pollInfo(record),
        active: record.getBool("active"),
        created_at: record.getString("created_at").replace(" ", "T"),
        participant_goal: record.getInt("participant_goal") || null,
        total_votes: participantCount(record, votes),
        options: options.map(({ id, label }) => ({ id, label, votes: counts.get(id) })),
    };
}

function duration(value) {
    if (!Number.isInteger(value) || value < 1 || value > 365) {
        throw new BadRequestError("Der Zeitraum muss zwischen 1 und 365 Tagen liegen.");
    }
    return value * day;
}

function create(app, input) {
    const question = typeof input.p_question === "string" ? input.p_question.trim() : "";
    const questionLength = Array.from(question).length;
    if (questionLength < 3 || questionLength > 300) throw new BadRequestError("Bitte eine gültige Frage eintragen.");
    const answers = input.p_options;
    if (!Array.isArray(answers) || answers.length < 2) throw new BadRequestError("Mindestens zwei Antworten sind erforderlich.");
    const options = answers.map((answer, index) => {
        const label = typeof answer === "string" ? answer.trim() : "";
        if (!label || Array.from(label).length > 200) throw new BadRequestError("Bitte überprüfe die Antworten.");
        return { id: index + 1, label, votes: 0 };
    });
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
        const records = e.app.findRecordsByFilter("staging_polls", "", "-created_at,-id", 50, 0);
        return e.json(200, { data: records.map(record => adminPoll(e.app, record)) });
    }
    if (action === "create_site_poll") return e.json(200, { data: create(e.app, input) });
    e.app.runInTransaction(app => {
        const poll = findPoll(app, input.p_poll_id);
        switch (action) {
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
        return e.json(200, { data: polls.map(poll => ({ ...pollInfo(poll), has_voted: voted.has(poll.id),
            options: pollOptions(poll).map(({ id, label }) => ({ id, label })) })) });
    }
    if (action !== "vote_in_poll_multi") throw new NotFoundError();
    let notice;
    e.app.runInTransaction(app => {
        const poll = findPoll(app, input.p_poll_id);
        if (!poll.getBool("active") || Date.parse(pollInfo(poll).ends_at) <= Date.now()) {
            throw new BadRequestError("Diese Abstimmung ist nicht mehr aktiv.");
        }
        if (!Array.isArray(input.p_option_ids) || !input.p_option_ids.length) {
            throw new BadRequestError("Bitte mindestens eine Antwort auswählen.");
        }
        const choices = [...new Set(input.p_option_ids)];
        const options = new Set(pollOptions(poll).map(option => option.id));
        if (!choices.every(choice => options.has(choice))) throw new BadRequestError("Eine Antwort gehört nicht zur Abstimmung.");
        const previous = app.findRecordsByFilter("staging_poll_ballots", "poll = {:poll} && voter = {:voter}", "", 1, 0,
            { poll: poll.id, voter });
        if (previous.length) throw new ApiError(409, "Du hast bereits abgestimmt.");
        const ballot = new Record(app.findCollectionByNameOrId("staging_poll_ballots"));
        ballot.set("poll", poll.id);
        ballot.set("voter", voter);
        ballot.set("choices", choices);
        app.save(ballot);
        const selected = pollOptions(poll).filter(option => choices.includes(option.id)).map(option => `• ${option.label}`);
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
        const options = poll.options.map(option => `• ${option.label}: ${option.votes} Stimmen`);
        const result = `📊 Abstimmung beendet\n\n❓ ${poll.question}\n\n${options.join("\n") || "Keine Stimmen abgegeben."}\n\n👥 Teilnehmer: ${poll.total_votes}\n🕒 Ende: ${delivery.telegramTime(poll.ends_at)}`;
        delivery.enqueue(app, "dolly", result, `poll-result:${poll.id}:${poll.ends_at}`);
    }
}

module.exports = { admin, visitor, queueResults };
