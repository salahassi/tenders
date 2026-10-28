import importlib.util,json,subprocess,sys,unittest
from pathlib import Path
from test_transfer_sources import fixture
spec=importlib.util.spec_from_file_location('tested_reader_repair',Path(__file__).with_name('repair-source-reading.py'))
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)


class ReaderRecoveryTests(unittest.TestCase):
    def test_postgres_reader_restore_preserves_disable_state_and_recovers_only_selected_job(self):
        p=fixture();p['sources'][1]['adapter_config']['catalog']['key']='sa-etimad'
        p['sources'][2]['adapter_config'].pop('automatic')
        result=subprocess.run(['node',str(Path(__file__).with_name('test_repair_source_reading.mjs'))],
          input=json.dumps({'fixture':p,'sql':r.repair_sql(p)}),text=True,capture_output=True,timeout=90)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__=='__main__':unittest.main()
