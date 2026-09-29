"""Static regression guards for anti-amnesia scope and injection behavior."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "index.ts").read_text(encoding="utf-8")
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


class AntiAmnesiaGuardrails(unittest.TestCase):
    def test_session_id_is_part_of_card_identity(self):
        self.assertIn("ctx.sessionManager.getSessionId()", SOURCE)

    def test_project_card_is_not_loaded_as_active_memory(self):
        self.assertNotIn("readText(projectCardPath)", SOURCE)
        self.assertIn("non verrà caricata automaticamente", SOURCE)

    def test_shared_draft_is_only_loaded_explicitly(self):
        self.assertIn("if (soloBozza)", SOURCE)

    def test_cross_session_key_is_rejected(self):
        self.assertIn("chiave-sessione-diversa", SOURCE)

    def test_card_injection_has_no_hardcoded_global_rules(self):
        self.assertNotIn("REGOLA_CRONJOB_CARTA", SOURCE)

    def test_periodic_and_random_channels_remain_core_defaults(self):
        self.assertIs(CONFIG["canalePeriodico"], True)
        self.assertIs(CONFIG["canaleRandomReview"], True)
        self.assertIn("canalePeriodico: true", SOURCE)
        self.assertIn("canaleRandomReview: true", SOURCE)

    def test_topic_is_not_guessed_from_system_prompt(self):
        self.assertNotIn("extractTopic", SOURCE)
        self.assertNotIn("TOPIC RILEVATO", SOURCE)

    def test_config_boolean_values_are_validated(self):
        self.assertIn("typeof cfg[field] !== 'boolean'", SOURCE)

    def test_old_persistent_messages_are_filtered(self):
        self.assertIn("const cleanMessages = event.messages.filter", SOURCE)
        self.assertNotIn("deliverAs: 'nextTurn'", SOURCE)

    def test_saved_card_key_updates_in_place(self):
        self.assertIn("const target = globalCardPath();", SOURCE)
        self.assertNotIn("Chiave \"${chiaveOriginale}\" già esistente", SOURCE)


if __name__ == "__main__":
    unittest.main()
