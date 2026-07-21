#!/usr/bin/env python3
import sys
from huggingface_hub import snapshot_download

model = sys.argv[1]
print(snapshot_download(repo_id=model))
