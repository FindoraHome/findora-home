window.FindoraStagingPollRpc = async (scope, action, input = {}, token = "") => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = token;
    try {
        const response = await fetch(`/api/findora/${scope}/${action}`, {
            method: "POST", headers, body: JSON.stringify(input),
        });
        const payload = await response.json();
        if (!response.ok) return { error: { message: payload.message }, status: response.status };
        return { data: payload.data, error: null };
    } catch (_) {
        return { error: { message: "Die Abstimmungen sind gerade nicht erreichbar." } };
    }
};
