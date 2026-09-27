package com.bilingify.readest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HouseholdSyncStatusTest {
    @Test
    fun `parses the launcher wire contract regardless of field order`() {
        assertEquals(
            HouseholdSyncStatus.Status(3, 1700000000000L, "syncing", 1700000000001L),
            HouseholdSyncStatus.parse("""{"updated_at":1700000000001,"state":"syncing","pending":3,"last_sync_at":1700000000000}"""),
        )
        for (state in listOf("idle", "offline", "error", "unpaired")) {
            assertEquals(state, HouseholdSyncStatus.parse("""{"pending":0,"last_sync_at":0,"state":"$state","updated_at":0}""")?.state)
        }
    }

    @Test
    fun `rejects malformed or non-contract data without coercion`() {
        val bad = listOf(
            """{"pending":-1,"last_sync_at":0,"state":"idle","updated_at":0}""",
            """{"pending":1.5,"last_sync_at":0,"state":"idle","updated_at":0}""",
            """{"pending":2147483648,"last_sync_at":0,"state":"idle","updated_at":0}""",
            """{"pending":"1","last_sync_at":0,"state":"idle","updated_at":0}""",
            """{"pending":0,"last_sync_at":"0","state":"idle","updated_at":0}""",
            """{"pending":0,"last_sync_at":0,"state":"unknown","updated_at":0}""",
            """{"pending":0,"last_sync_at":0,"state":"idle","updated_at":9223372036854775808}""",
            """{"pending":0,"last_sync_at":0,"state":"idle"}""",
            """{"pending":0,"pending":1,"last_sync_at":0,"state":"idle","updated_at":0}""",
            """{"pending":0,"last_sync_at":0,"state":"idle","updated_at":0,"token":"secret"}""",
            "not json",
        )
        bad.forEach { assertNull(it, HouseholdSyncStatus.parse(it)) }
    }
}
