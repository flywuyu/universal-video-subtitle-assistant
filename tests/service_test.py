import importlib.util
import pathlib
import queue
import threading
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("subtitle_server", ROOT / "local_service" / "server.py")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class ServiceTests(unittest.TestCase):
    def test_public_video_addresses(self):
        self.assertTrue(server.valid_video_url("https://www.bilibili.com/video/BV123/"))
        self.assertFalse(server.valid_video_url("http://127.0.0.1/private"))
        self.assertFalse(server.valid_video_url("http://192.168.1.2/private"))
        self.assertFalse(server.valid_video_url("file:///C:/secret"))

    def test_bili_audio_host(self):
        self.assertTrue(server.valid_bili_audio_url("https://upos-sz.bilivideo.com/audio.m4s"))
        self.assertFalse(server.valid_bili_audio_url("https://bilivideo.com.attacker.example/audio.m4s"))

    def test_live_chunks_keep_video_time(self):
        job_id = "test-live"
        chunks = queue.Queue()
        chunks.put((b"fake audio", 120.0))
        chunks.put(None)
        server.JOBS[job_id] = {"id": job_id, "status": "running", "segments": [], "duration": 0,
                               "created_at":0,"model":"tiny"}
        server.LIVE_QUEUES[job_id] = chunks
        server.STOP_EVENTS[job_id] = threading.Event()
        with patch.object(server, "decode_clip", return_value=[1,2,3]), \
             patch.object(server.ENGINE, "recognize", return_value=([
                 {"start":1.0,"end":2.0,"text":"你好"}], "zh", 0.1)):
            server.run_live_job(job_id, chunks, server.STOP_EVENTS[job_id])
        self.assertEqual(server.JOBS[job_id]["segments"][0]["start"], 121.0)
        self.assertEqual(server.JOBS[job_id]["status"], "done")
        server.JOBS.pop(job_id)

    def test_quality_pass_replaces_first_draft_instead_of_duplicating_it(self):
        job_id=server.new_job('https://example.com/video','file',profile='balanced')
        with patch.object(server.ENGINE,'model_name',''),patch.object(server.ENGINE,'recognize',side_effect=[
            ([{'start':0,'end':1,'text':'rough draft'}],'en',0.1),
            ([{'start':0,'end':1,'text':'corrected transcript'}],'en',0.2)]):
            server.recognize_part(job_id,[1,2],120)
        job=server.JOBS[job_id]
        self.assertEqual([row['text'] for row in job['segments']],['corrected transcript'])
        self.assertEqual(job['segments'][0]['start'],120)
        self.assertEqual(job['quality_phase'],'final')
        self.assertGreater(job['first_result_ms'],-1)
        server.JOBS.pop(job_id)
        server.STOP_EVENTS.pop(job_id)


if __name__ == "__main__":
    unittest.main()
