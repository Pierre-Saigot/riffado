/**
 * Regression: #327 follow-up.
 *
 * Plaud 4.0 listings carry no file size. When the v4 detail has no size
 * either, the pre-download storage check sees 0 bytes, so the downloaded
 * size must be checked against the cap before the upload.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/hosted/billing/storage-cap", () => ({
    enforceStorageCap: vi.fn(),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: vi.fn().mockResolvedValue(undefined),
        downloadFile: vi.fn(),
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock("@/lib/notifications/bark", () => ({
    sendNewRecordingBarkNotification: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/notifications/email", () => ({
    sendNewRecordingEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

import { db } from "@/db";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";

const USER = "user-327";
const CAP_BYTES = 100;
const audio = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(196)]);

function v4Recording(filesize: number) {
    return {
        id: "f_new",
        filename: "2026-10-28 11:43:10",
        duration: 1000,
        start_time: Date.UTC(2026, 9, 28, 10, 43, 10),
        end_time: Date.UTC(2026, 9, 28, 10, 43, 11),
        filesize,
        file_md5: "",
        serial_number: "SN327",
        version_ms: 1,
        edit_time: 1,
        timezone: 1,
        zonemins: 0,
        scene: 0,
        is_trash: false,
        is_trans: false,
        is_summary: false,
        source: "v4",
    };
}

function stubPlaud(filesize: number) {
    (createPlaudClient as Mock).mockResolvedValue({
        getRecordings: vi.fn().mockResolvedValue({
            data_file_list: [v4Recording(filesize)],
        }),
        hydrateRecording: vi.fn(async (r: unknown) => r),
        downloadRecording: vi.fn().mockResolvedValue(audio),
    });
}

function stubDb() {
    const select = (db.select as Mock).mockReset();
    for (const result of [
        [{ id: "conn-1", userId: USER, bearerToken: "tok" }],
        [{ id: "settings-1" }],
        [{ email: "t@example.com" }],
    ]) {
        select.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue(result),
                }),
            }),
        });
    }
    select.mockReturnValue({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
            }),
        }),
    });
    (db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "new-rec" }]),
        }),
    });
    (db.update as Mock).mockReturnValue({
        set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
        }),
    });
}

describe("#327 storage cap with unknown Plaud 4.0 sizes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (enforceStorageCap as Mock).mockImplementation(
            async ({ additionalBytes }: { additionalBytes: number }) => ({
                allowed: additionalBytes <= CAP_BYTES,
                currentBytes: 0,
                limitBytes: CAP_BYTES,
            }),
        );
        stubDb();
    });

    it("checks the downloaded size before uploading when the size is unknown", async () => {
        stubPlaud(0);
        const storage = (await createUserStorageProvider(USER)) as unknown as {
            uploadFile: Mock;
        };
        storage.uploadFile.mockClear();

        const result = await syncRecordingsForUser(USER);

        expect(
            (enforceStorageCap as Mock).mock.calls.map(
                ([arg]) => arg.additionalBytes,
            ),
        ).toEqual([0, audio.length]);
        expect(result.newRecordings).toBe(0);
        expect(storage.uploadFile).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("keeps a single pre-download check when the size is known", async () => {
        stubPlaud(audio.length);

        const result = await syncRecordingsForUser(USER);

        expect(enforceStorageCap).toHaveBeenCalledTimes(1);
        expect(result.newRecordings).toBe(0);
        expect(db.insert).not.toHaveBeenCalled();
    });
});
