"""Secretary's speaker grouping: neural voice prints cluster into the right number of people, tiny fragments fold
into real speakers, and renamed speakers keep their names."""
import unittest

import numpy as np

from smoke_test import client, shellb  # noqa: F401 — sets up the scratch copy

import secretary


def voices(n_speakers=3, each=20, dim=256, noise=0.35, seed=7):
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(n_speakers, dim))
    out = []
    for s in range(n_speakers):
        for _ in range(each):
            v = centers[s] / np.linalg.norm(centers[s]) + rng.normal(scale=noise / np.sqrt(dim), size=dim)
            out.append((s, v / np.linalg.norm(v)))
    return out


class Clustering(unittest.TestCase):
    def test_three_people_three_clusters(self):
        data = voices()
        groups = secretary._cosine_cluster([v for _, v in data], [3.0] * len(data), 0.65)
        self.assertEqual(len(groups), 3)
        for g in groups:
            self.assertEqual(len({data[i][0] for i in g}), 1)  # every group is one person

    def test_fragment_folds_into_a_real_speaker(self):
        data = voices(2, 10)
        rng = np.random.default_rng(1)
        odd = rng.normal(size=256)
        vecs = [v for _, v in data] + [odd / np.linalg.norm(odd)]  # one 0.6 s blip that matches nobody
        groups = secretary._cosine_cluster(vecs, [3.0] * 20 + [0.6], 0.65)
        self.assertEqual(len(groups), 2)

    def test_fixed_count(self):
        data = voices(4, 8)
        self.assertEqual(len(secretary._cosine_cluster([v for _, v in data], [2.0] * 32, 0.65, k=2)), 2)


class Names(unittest.TestCase):
    def test_renamed_speakers_keep_their_names(self):
        m = {"speakers": [{"id": "spk_1", "name": "Brad", "color": "#fff"}, {"id": "spk_2", "name": "Jenn", "color": "#000"}],
             "utterances": [{"id": f"u{i}", "speakerId": "spk_1" if i < 3 else "spk_2", "start": i, "end": i + 1,
                             "speakerName": ""} for i in range(6)]}
        secretary._apply_clusters(m, [["u0", "u1", "u2"], ["u3", "u4", "u5"]])
        self.assertEqual([s["name"] for s in m["speakers"]], ["Brad", "Jenn"])
        self.assertEqual(m["utterances"][4]["speakerName"], "Jenn")


if __name__ == "__main__":
    unittest.main()
