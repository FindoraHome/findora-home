migrate((app) => {
    const polls = new Collection({
        type: "base",
        name: "staging_polls",
        fields: [
            { name: "legacy_id", type: "text", pattern: "^[0-9]+$" },
            { name: "question", type: "text", required: true, min: 3, max: 300 },
            { name: "active", type: "bool" },
            { name: "created_at", type: "date", required: true },
            { name: "ends_at", type: "date", required: true },
            { name: "participant_goal", type: "number", onlyInt: true, min: 0, max: 100000 },
            { name: "options", type: "json", required: true },
            { name: "imported_participants", type: "number", onlyInt: true, min: 0 },
        ],
        indexes: [
            "CREATE UNIQUE INDEX idx_staging_polls_legacy_id ON staging_polls (legacy_id) WHERE legacy_id <> ''",
            "CREATE INDEX idx_staging_polls_active_end ON staging_polls (active, ends_at)",
        ],
    });
    app.save(polls);
    app.save(new Collection({
        type: "base",
        name: "staging_poll_ballots",
        fields: [
            { name: "poll", type: "relation", collectionId: polls.id, required: true, maxSelect: 1, cascadeDelete: true },
            { name: "voter", type: "text", required: true, pattern: "^[a-f0-9]{64}$" },
            { name: "choices", type: "json", required: true },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_staging_poll_ballot_voter ON staging_poll_ballots (poll, voter)"],
    }));
}, (app) => {
    app.delete(app.findCollectionByNameOrId("staging_poll_ballots"));
    app.delete(app.findCollectionByNameOrId("staging_polls"));
});
