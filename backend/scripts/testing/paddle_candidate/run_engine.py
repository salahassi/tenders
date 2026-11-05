"""One offline candidate page. Never load gold or repair/reorder model output."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

started=time.monotonic()
image_path,output_dir=Path(sys.argv[1]),Path(sys.argv[2])
config_path=Path('/experiment/experiment-config.json')
config=json.loads(config_path.read_text())


def plain(value):
    if hasattr(value,'tolist'):
        return plain(value.tolist())
    if isinstance(value,dict):return {str(k):plain(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)):return [plain(v) for v in value]
    if value is None or isinstance(value,(str,int,float,bool)):return value
    raise TypeError('Unexpected retained result type '+type(value).__name__)


def save(name,value):
    with (output_dir/name).open('x') as out:
        json.dump(value,out,ensure_ascii=False,allow_nan=False,indent=2);out.write('\n')


try:
    import paddle
    import paddleocr
    from paddleocr import PaddleOCR
    imported=time.monotonic()
    engine=PaddleOCR(**config['constructor'])
    initialized=time.monotonic()
    merged=plain(engine._merged_paddlex_config)
    common=plain(engine._common_args)
    assert common['engine']=='paddle_static' and common['device']=='cpu'
    assert common['engine_config']==config['constructor']['engine_config']
    assert merged['use_doc_preprocessor'] is False and merged['use_textline_orientation'] is False
    for key in ['TextDetection','TextRecognition']:
        expected=config['constructor']['paddlex_config']['SubModules'][key]
        actual=merged['SubModules'][key]
        assert all(actual.get(k)==v for k,v in expected.items()), 'Effective model setting changed'
    save('effective-config.json',{'merged_pipeline':merged,'common_args':common,
        'paddle_version':paddle.__version__,'paddleocr_version':paddleocr.__version__,
        'pid':os.getpid(),'ppid':os.getppid(),'cgroup':Path('/proc/self/cgroup').read_text(),
        'config_sha256':hashlib.sha256(config_path.read_bytes()).hexdigest()})
    pages=list(engine.predict(str(image_path)))
    assert len(pages)==1, 'Exactly one page result is required'
    result=pages[0]
    keys=['rec_texts','rec_scores','dt_polys','rec_polys','rec_boxes',
          'dt_scores','text_det_params','text_rec_score_thresh','textline_orientation_angles']
    retained={key:plain(result[key]) for key in keys if key in result}
    assert all(key in retained for key in ['rec_texts','rec_scores','dt_polys','rec_polys','rec_boxes'])
    assert isinstance(retained['rec_texts'],list) and all(isinstance(v,str) for v in retained['rec_texts'])
    assert len(retained['rec_texts'])==len(retained['rec_scores'])==len(retained['rec_polys'])==len(retained['rec_boxes'])
    assert retained.get('text_rec_score_thresh')==0.0
    save('raw-engine.json',{'engine':'paddle_static','paddle_version':paddle.__version__,
        'paddleocr_version':paddleocr.__version__,'source_image_sha256':hashlib.sha256(image_path.read_bytes()).hexdigest(),
        'text_transform_scope':'upstream returned Arabic strings are post-bidi display transformation; unchanged here',
        'result':retained,'timing_ms':{'imports':round((imported-started)*1000),
        'initialization':round((initialized-imported)*1000),'total':round((time.monotonic()-started)*1000)}})
    engine.close()
except BaseException as error:
    save('engine-failure.json',{'type':type(error).__name__,'message':str(error)[:4000],
        'elapsed_ms':round((time.monotonic()-started)*1000),'raw_outputs_are_not_repaired':True})
    raise
