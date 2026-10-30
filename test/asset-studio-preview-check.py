import pathlib
root=pathlib.Path(__file__).resolve().parents[1]/'issuer-php/atlas/studio'
for name in ['index.html','studio.js','studio.css','api.php']:
    assert (root/name).is_file(), name
html=(root/'index.html').read_text()
assert 'disabled' in html and 'Mint to Wallet' in html
api=(root/'api.php').read_text()
assert '403' in api and 'minting-not-enabled' in api
print('Asset Studio preview smoke checks passed')
