# data/

Drop raw NPPES CSV files here. The pipeline reads them straight off disk with a
stream, so file size is not limited by the browser or by any upload timeout —
a 10GB+ `npidata_pfile_*.csv` works fine.

1. Copy (or move) the CSV into this folder.
2. Open the Pipeline page, hit **Refresh** on the file list, pick the file.
3. Run **Filter & Score**.

Files in here are gitignored.
